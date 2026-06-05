FROM node:25-alpine

WORKDIR /app
COPY package.json server.js index.html admin.html README.md ./

ENV NODE_ENV=production
ENV PORT=8123
ENV HOST=0.0.0.0
ENV DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 8123

CMD ["node", "server.js"]
