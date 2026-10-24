FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts/build-web.mjs ./scripts/build-web.mjs
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 MOTION_STATE_PATH=/var/data/motion/state.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /var/data/motion && chown node:node /var/data/motion
USER node
EXPOSE 8787
CMD ["node","dist/http.js"]
