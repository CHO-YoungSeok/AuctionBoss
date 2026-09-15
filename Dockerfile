# Base node image
FROM node:20-slim AS base

# Install python and build-essential for better-sqlite3 native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    gcc \
    && rm -rf /var/lib/apt/lists/*

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

# Create data directory for sqlite DB
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

EXPOSE 3000

USER node

CMD ["npm", "run", "start"]
