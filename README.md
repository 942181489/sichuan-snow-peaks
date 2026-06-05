# Sichuan Snow Peaks

## Run locally

```powershell
node server.js
```

Open:

```text
http://127.0.0.1:8123
```

Admin page:

```text
http://127.0.0.1:8123/admin.html
```

Default admin token is `change-me`. Change it before sharing the site.

## Database

The backend database is:

```text
data/site.db
```

It stores applications and orders. The admin page can export applications and
orders as CSV files that open in Excel.

## China company payment setup

For a China-registered company, use a merchant payment product such as WeChat
Pay or Alipay. This project currently includes WeChat Pay API v3 Native QR order
creation and webhook handling.

Set these environment variables before starting the server:

```powershell
$env:ADMIN_TOKEN="choose-a-strong-admin-password"
$env:PUBLIC_BASE_URL="https://your-real-https-domain.example"
$env:WECHAT_PAY_MCH_ID="your_mch_id"
$env:WECHAT_PAY_APP_ID="your_app_id"
$env:WECHAT_PAY_CERT_SERIAL_NO="your_merchant_cert_serial_no"
$env:WECHAT_PAY_API_V3_KEY="your_32_character_api_v3_key"
$env:WECHAT_PAY_PRIVATE_KEY_PATH="C:\secure\apiclient_key.pem"
node server.js
```

Configure the WeChat Pay notify URL as:

```text
https://your-real-https-domain.example/api/wechatpay/notify
```

If WeChat Pay variables are not configured, the website still saves the
application and order, then asks the operator to confirm payment manually.

## Important

Do not store card numbers, WeChat passwords, Alipay passwords, or customer ID
documents in this database. Payment credentials should stay in environment
variables or a secure server secret manager.

## Cloud deployment

This is a backend app, not a static-only website. Deploy it as a Node/Docker web
service and attach persistent storage for `data/site.db`.

### Recommended option: Render

The repository includes:

```text
Dockerfile
render.yaml
```

On Render:

1. Create a new Blueprint or Web Service from this project repository.
2. Use Docker runtime.
3. Attach a persistent disk mounted at `/data`.
4. Set environment variables:

```text
DATA_DIR=/data
ADMIN_TOKEN=choose-a-strong-admin-password
PUBLIC_BASE_URL=https://your-render-domain.onrender.com
```

For live WeChat Pay, also set:

```text
WECHAT_PAY_MCH_ID=...
WECHAT_PAY_APP_ID=...
WECHAT_PAY_CERT_SERIAL_NO=...
WECHAT_PAY_API_V3_KEY=...
WECHAT_PAY_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
```

Then configure WeChat Pay notify URL:

```text
https://your-render-domain.onrender.com/api/wechatpay/notify
```

### Railway option

The repository includes:

```text
Dockerfile
railway.json
```

On Railway:

1. Deploy from this project repository.
2. Add a volume mounted to `/data`.
3. Set `DATA_DIR=/data`.
4. Set `ADMIN_TOKEN` and `PUBLIC_BASE_URL`.

### Important for SQLite

Without a persistent disk or volume, the cloud platform may delete the database
after restart or redeploy. Keep `DATA_DIR` on mounted storage.
