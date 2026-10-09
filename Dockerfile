# Base node image. 네이티브 모듈이 없어 빌드 도구를 설치하지 않는다(SQLite 은퇴: migrate-data-and-cutover 8.5).
FROM node:22-slim AS base

# Builder stage
FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runner stage
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy node_modules and build artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/workers ./workers
COPY --from=builder /app/config ./config
COPY --from=builder /app/next.config.ts ./
# tsx가 워커의 "@/*" 경로 별칭을 해석하는 데 필요하다(없으면 MODULE_NOT_FOUND).
COPY --from=builder /app/tsconfig.json ./

EXPOSE 3000

USER node

CMD ["npm", "run", "start"]
