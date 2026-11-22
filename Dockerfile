# 依存の取得(本番用のみ)
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# 起動係が使う docker コマンド(クライアントだけ)
FROM docker:29-cli AS docker-cli

# 事務局、起動係、プロキシに共通の土台
FROM node:22-slim AS base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src ./src
COPY scripts ./scripts
# 名前付きボリュームを重ねても、node ユーザーが書けるようにしておく。
#   /data          DBファイルと、事務局専用のデータ
#   /work          イシューごとの作業場所
#   /run/launcher  事務局と起動係が共有するソケット
RUN mkdir -p /data /work /run/launcher \
  && chown node:node /data /work /run/launcher
USER node

# 起動係。Dockerソケットを持つので、docker コマンドを足す。
FROM base AS launcher
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
CMD ["node", "src/launcher/main.ts"]

# 事務局(プロキシも同じイメージを、別のコマンドで使う)。
# 最後に置いて、対象を指定しないビルドの既定にする。
FROM base AS office
CMD ["node", "src/office/main.ts"]
