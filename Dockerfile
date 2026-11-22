# 依存の取得(本番用のみ)
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# 事務局
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src ./src
# DBファイルの置き場所。名前付きボリュームを重ねても、node ユーザーが書けるようにしておく。
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "src/office/main.ts"]
