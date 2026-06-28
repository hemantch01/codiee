# ---------- Stage 1: build ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Dependency layer (cached unless lockfile changes)
COPY package.json package-lock.json ./
RUN npm ci

# Prisma schema is needed for client generation before compiling
COPY prisma ./prisma
RUN npx prisma generate

# Compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Production dependencies only — devDeps (vitest, tsx, typescript) stay out
# of the runtime image. prisma CLI ships in dependencies for generate.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

# Run as non-root user
USER node

COPY --from=builder /app/dist ./dist

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3005) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
