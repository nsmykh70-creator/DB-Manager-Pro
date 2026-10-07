FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# better-sqlite3 ships prebuilds; toolchain is only a fallback for source builds.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Enables the strict production guard in backend/src/core/config.ts:
# JWT_SECRET / ENCRYPTION_KEY / ADMIN_PASSWORD must be real values.
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    META_PATH=/data/meta.db
RUN mkdir -p /data
EXPOSE 3001
CMD ["node", "dist/index.js"]
