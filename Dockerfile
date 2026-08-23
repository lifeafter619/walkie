FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts：better-sqlite3 13 在 tarball 里自带各平台 N-API 预编译产物（gypfile:false），
# 但 npm ≥11.17 仍会给它造一个隐式 `node-gyp rebuild`。slim 镜像没有 python3/g++，
# 编译必挂——而这次编译本来就是多余的。esbuild/workerd 的二进制来自各自的平台包，不依赖脚本。
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/app/data WALKIE_RUNTIME=docker
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4310
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4310/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/index.js"]
