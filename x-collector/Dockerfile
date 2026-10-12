FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json eslint.config.mjs ./
COPY lib ./lib
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev
RUN find scripts -name '*.cjs' -exec cp --parents {} dist/ \;

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
RUN node node_modules/playwright/cli.js install --with-deps chromium
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY config ./config
COPY public ./public
RUN mkdir -p /app/logs /app/data && chown node:node /app/logs /app/data
USER node
CMD ["node", "dist/scripts/reply/api.js"]
