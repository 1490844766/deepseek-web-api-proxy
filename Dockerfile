FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --production && npm cache clean --force

COPY server.js ./

RUN mkdir -p /data && echo '{"token":"","cookie":"","wasmUrl":"https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm","baseUrl":"https://chat.deepseek.com"}' > /app/auth.json

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD curl -f http://localhost:8000/health || exit 1

CMD ["node", "server.js"]
