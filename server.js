const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const dbPath = path.join(dataDir, "site.db");
const port = Number(process.env.PORT || 8123);
const listenHost = process.env.HOST || "0.0.0.0";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;
const adminToken = process.env.ADMIN_TOKEN || "change-me";

fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    peak TEXT,
    dates TEXT,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'new'
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    provider TEXT NOT NULL,
    amount_cny INTEGER NOT NULL,
    status TEXT NOT NULL,
    provider_order_id TEXT,
    provider_payload TEXT,
    paid_at TEXT,
    notes TEXT,
    FOREIGN KEY(application_id) REFERENCES applications(id)
  );
`);

const deposits = {
  inquiry: null,
  deposit_1500: 150000,
  deposit_3500: 350000
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function yuan(cents) {
  return (cents / 100).toFixed(2);
}

async function readRaw(req, limit = 500000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readRaw(req);
  return JSON.parse(raw.toString("utf8") || "{}");
}

function requireAdmin(req, res) {
  const tokenFromHeader = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const tokenFromQuery = new URL(req.url, publicBaseUrl).searchParams.get("token") || "";
  const token = tokenFromHeader || tokenFromQuery;
  if (token !== adminToken) {
    sendJson(res, 401, { error: "Admin token required." });
    return false;
  }
  return true;
}

function createApplication(input) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO applications (id, created_at, name, country, email, phone, peak, dates, message, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
  `).run(
    id,
    now,
    String(input.name || "").trim(),
    String(input.country || "").trim(),
    String(input.email || "").trim(),
    String(input.phone || "").trim(),
    String(input.peak || "Help me choose").trim(),
    String(input.dates || "").trim(),
    String(input.message || "").trim()
  );
  return { id, created_at: now };
}

function createOrder(applicationId, provider, amountCny, status = "pending", providerPayload = null) {
  const id = `SNP${Date.now()}${crypto.randomInt(1000, 9999)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO orders (id, application_id, created_at, provider, amount_cny, status, provider_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, applicationId, now, provider, amountCny, status, providerPayload ? JSON.stringify(providerPayload) : null);
  return { id, created_at: now, amount_cny: amountCny, status, provider };
}

function loadPrivateKey() {
  const keyPath = process.env.WECHAT_PAY_PRIVATE_KEY_PATH;
  const keyText = process.env.WECHAT_PAY_PRIVATE_KEY;
  if (keyText) return keyText.replaceAll("\\n", "\n");
  if (keyPath) return fs.readFileSync(keyPath, "utf8");
  return null;
}

function wechatPayReady() {
  return Boolean(
    process.env.WECHAT_PAY_MCH_ID &&
    process.env.WECHAT_PAY_APP_ID &&
    process.env.WECHAT_PAY_CERT_SERIAL_NO &&
    loadPrivateKey() &&
    process.env.WECHAT_PAY_API_V3_KEY
  );
}

function signWechat(method, urlPath, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = crypto.createSign("RSA-SHA256").update(message).sign(loadPrivateKey(), "base64");
  const mchid = process.env.WECHAT_PAY_MCH_ID;
  const serial = process.env.WECHAT_PAY_CERT_SERIAL_NO;
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serial}"`;
}

async function createWechatNativePayment(order, application) {
  if (!wechatPayReady()) {
    return {
      configured: false,
      message: "WeChat Pay is not configured yet. Order saved for manual confirmation."
    };
  }

  const urlPath = "/v3/pay/transactions/native";
  const body = JSON.stringify({
    appid: process.env.WECHAT_PAY_APP_ID,
    mchid: process.env.WECHAT_PAY_MCH_ID,
    description: "Sichuan Snow Peaks expedition deposit",
    out_trade_no: order.id,
    notify_url: `${publicBaseUrl}/api/wechatpay/notify`,
    amount: { total: order.amount_cny, currency: "CNY" },
    attach: application.id
  });

  const response = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: "POST",
    headers: {
      Authorization: signWechat("POST", urlPath, body),
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "WeChat Pay order creation failed.");

  db.prepare("UPDATE orders SET provider_payload = ? WHERE id = ?").run(JSON.stringify(payload), order.id);
  return { configured: true, codeUrl: payload.code_url };
}

function decryptWechatResource(resource) {
  const apiV3Key = process.env.WECHAT_PAY_API_V3_KEY;
  if (!apiV3Key) throw new Error("WECHAT_PAY_API_V3_KEY is not configured.");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key, "utf8"),
    Buffer.from(resource.nonce, "utf8")
  );
  decipher.setAuthTag(Buffer.from(resource.ciphertext, "base64").subarray(-16));
  decipher.setAAD(Buffer.from(resource.associated_data || "", "utf8"));
  const encrypted = Buffer.from(resource.ciphertext, "base64").subarray(0, -16);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
}

async function handleApplication(req, res) {
  try {
    const input = await readJson(req);
    for (const field of ["name", "country", "email", "phone"]) {
      if (!String(input[field] || "").trim()) return sendJson(res, 400, { error: `Missing ${field}.` });
    }

    const app = createApplication(input);
    const paymentOption = String(input.paymentOption || "inquiry");
    const amount = deposits[paymentOption];

    if (!amount) {
      return sendJson(res, 201, {
        applicationId: app.id,
        message: "Application saved. We will contact you with dates, price, insurance, and payment instructions."
      });
    }

    const provider = String(input.paymentProvider || "manual");
    const order = createOrder(app.id, provider, amount);
    const application = { id: app.id, email: input.email, name: input.name };

    if (provider === "wechat_native") {
      const wechat = await createWechatNativePayment(order, application);
      return sendJson(res, 201, {
        applicationId: app.id,
        orderId: order.id,
        amountCny: yuan(amount),
        paymentProvider: provider,
        codeUrl: wechat.codeUrl,
        message: wechat.configured ? "Scan the WeChat Pay QR code to pay." : wechat.message
      });
    }

    return sendJson(res, 201, {
      applicationId: app.id,
      orderId: order.id,
      amountCny: yuan(amount),
      paymentProvider: provider,
      message: "Order saved. We will send a company payment QR code or bank transfer details after confirming availability."
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
}

async function handleWechatNotify(req, res) {
  try {
    const event = JSON.parse((await readRaw(req)).toString("utf8"));
    const tx = decryptWechatResource(event.resource);
    const paid = tx.trade_state === "SUCCESS";
    db.prepare(`
      UPDATE orders
      SET status = ?, provider_order_id = ?, paid_at = ?, provider_payload = ?
      WHERE id = ?
    `).run(
      paid ? "paid" : tx.trade_state,
      tx.transaction_id || null,
      paid ? new Date().toISOString() : null,
      JSON.stringify(tx),
      tx.out_trade_no
    );
    return sendJson(res, 200, { code: "SUCCESS", message: "success" });
  } catch (error) {
    return sendJson(res, 500, { code: "FAIL", message: error.message });
  }
}

function listRows() {
  const applications = db.prepare(`
    SELECT a.*,
      COUNT(o.id) AS order_count,
      COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.amount_cny ELSE 0 END), 0) AS paid_cny
    FROM applications a
    LEFT JOIN orders o ON o.application_id = a.id
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `).all();
  const orders = db.prepare(`
    SELECT o.*, a.name, a.email, a.phone, a.peak
    FROM orders o
    JOIN applications a ON a.id = o.application_id
    ORDER BY o.created_at DESC
  `).all();
  return { applications, orders };
}

async function handleAdminApi(req, res) {
  if (!requireAdmin(req, res)) return;
  const pathname = new URL(req.url, publicBaseUrl).pathname;

  if (req.method === "GET" && pathname === "/api/admin/summary") {
    return sendJson(res, 200, listRows());
  }

  if (req.method === "POST" && pathname.startsWith("/api/admin/orders/") && pathname.endsWith("/mark-paid")) {
    const orderId = pathname.split("/")[4];
    const input = await readJson(req).catch(() => ({}));
    db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, notes = ? WHERE id = ?")
      .run(new Date().toISOString(), String(input.notes || "Manual confirmation"), orderId);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Not found." });
}

function toCsv(rows) {
  const headers = rows[0] ? Object.keys(rows[0]) : ["empty"];
  const cell = (value) => `"${String(value ?? "").replaceAll('"', '""').replaceAll(/\r?\n/g, " ")}"`;
  return `${headers.map(cell).join(",")}\n${rows.map((row) => headers.map((key) => cell(row[key])).join(",")).join("\n")}`;
}

function handleExport(req, res) {
  if (!requireAdmin(req, res)) return;
  const pathname = new URL(req.url, publicBaseUrl).pathname;
  const rows = pathname.endsWith("/orders")
    ? db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all()
    : db.prepare("SELECT * FROM applications ORDER BY created_at DESC").all();
  sendText(res, 200, toCsv(rows), "text/csv; charset=utf-8");
}

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, publicBaseUrl).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(path.resolve(root)) || relative.startsWith("data")) {
    return sendText(res, 403, "Forbidden");
  }
  fs.readFile(filePath, (error, data) => {
    if (error) return sendText(res, 404, "Not found");
    const type = filePath.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
    sendText(res, 200, data, type);
  });
}

http.createServer(async (req, res) => {
  const pathname = new URL(req.url, publicBaseUrl).pathname;
  if (req.method === "POST" && pathname === "/api/applications") return handleApplication(req, res);
  if (req.method === "POST" && pathname === "/api/wechatpay/notify") return handleWechatNotify(req, res);
  if (pathname.startsWith("/api/admin/")) return handleAdminApi(req, res);
  if (pathname.startsWith("/api/export/")) return handleExport(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  sendText(res, 405, "Method not allowed");
}).listen(port, listenHost, () => {
  console.log(`Sichuan Snow Peaks running on ${listenHost}:${port}`);
  console.log(`SQLite database: ${dbPath}`);
  console.log(`Admin page: http://127.0.0.1:${port}/admin.html`);
});
