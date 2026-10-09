FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/bigint-safe packages/bigint-safe
COPY packages/braces-safe packages/braces-safe
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run prisma:generate -w @solsub/api && npm run build -w @solsub/bot

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/bigint-safe ./packages/bigint-safe
COPY --from=build /app/packages/braces-safe ./packages/braces-safe
COPY --from=build /app/apps/bot/dist ./apps/bot/dist
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/bot/package.json apps/bot/package.json
CMD ["node", "apps/bot/dist/index.js"]
