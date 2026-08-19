FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEB_URL
ARG NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
ARG NEXT_PUBLIC_SOLANA_CLUSTER
ARG NEXT_PUBLIC_RPC_ENDPOINT
ARG NEXT_PUBLIC_TREASURY_WALLET
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WEB_URL=$NEXT_PUBLIC_WEB_URL \
    NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=$NEXT_PUBLIC_TELEGRAM_BOT_USERNAME \
    NEXT_PUBLIC_SOLANA_CLUSTER=$NEXT_PUBLIC_SOLANA_CLUSTER \
    NEXT_PUBLIC_RPC_ENDPOINT=$NEXT_PUBLIC_RPC_ENDPOINT \
    NEXT_PUBLIC_TREASURY_WALLET=$NEXT_PUBLIC_TREASURY_WALLET
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @solsub/web

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "apps/web", "-p", "3000"]
