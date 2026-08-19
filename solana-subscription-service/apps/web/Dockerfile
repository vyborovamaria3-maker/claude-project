FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
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
CMD ["npm", "run", "start", "-w", "@solsub/web"]
