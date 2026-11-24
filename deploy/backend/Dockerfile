FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS node-runtime

FROM node-runtime AS workspace
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false
RUN npm install --global --ignore-scripts pnpm@9.15.9
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/pi-telemetry-compat/package.json packages/pi-telemetry-compat/package.json
RUN --mount=type=cache,id=cert-board-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY tsconfig.json tsconfig.base.json ./
COPY apps apps
COPY packages packages

FROM workspace AS backend
COPY agents agents
COPY skills skills
COPY knowledge/k05/us-510k-cover-letter.yaml knowledge/k05/us-510k-cover-letter.yaml
COPY deploy/models.yaml deploy/models.yaml
COPY deploy/egress/allowlist deploy/egress/allowlist
COPY deploy/backend/network-probe.mjs deploy/backend/network-probe.mjs
USER node
CMD ["node", "--import", "tsx", "apps/backend/src/server.ts"]

FROM node-runtime AS network-probe
WORKDIR /probe
COPY deploy/backend/network-probe.mjs deploy/backend/network-probe.mjs
USER node

FROM workspace AS web-build
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS web
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/backend/web.conf /etc/nginx/conf.d/default.conf
