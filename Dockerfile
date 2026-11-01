# Business API image. It has no Docker socket, no terminal executor and no
# sandbox toolchain.
FROM node:24.15.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/tmp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "src/server.js"]