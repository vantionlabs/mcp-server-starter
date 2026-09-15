# Node 24 runs the TypeScript sources directly, so there is no build step.
FROM node:24-alpine
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: `prepare` patches the dev-only language service.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

COPY src ./src

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "src/Main.ts"]
