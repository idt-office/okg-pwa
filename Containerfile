# Build-Stage: Web-App bauen.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/bff/package.json packages/bff/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

# Runtime: nur Produktionsabhängigkeiten plus Quellen, die tsx ausführt.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/bff/package.json packages/bff/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/core/src packages/core/src
COPY --from=build /app/packages/bff/src packages/bff/src
COPY --from=build /app/packages/web/dist packages/web/dist

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["npx", "tsx", "packages/bff/src/index.ts"]
