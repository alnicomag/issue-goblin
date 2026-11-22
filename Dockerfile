# 依存の取得(本番用のみ)
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# 起動係が使う docker コマンド(クライアントだけ)
FROM docker:29-cli AS docker-cli

# 事務局、起動係、プロキシに共通の実行環境(アプリのコードはまだ入れない)
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# 名前付きボリュームを重ねても、node ユーザーが書けるようにしておく。
#   /data          DBファイルと、事務局専用のデータ
#   /work          イシューごとの作業場所
#   /run/launcher  事務局と起動係が共有するソケット
RUN mkdir -p /data /work /run/launcher \
  && chown node:node /data /work /run/launcher

# 事務局の実行環境。製品リポジトリの取得と作業場所の準備に、git が要る。
# ca-certificates は、git がHTTPSの証明書を検証するために要る。
# アプリのコードより前に置いて、コードを変えるたびに入れ直さずに済むようにする。
FROM runtime AS runtime-git
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# アプリのコードを入れたもの。起動係とプロキシの土台にする(git は入れない)。
FROM runtime AS app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY prompts ./prompts
COPY src ./src
COPY scripts ./scripts
USER node

# 起動係。Dockerソケットを持つので、docker コマンドを足す。
FROM app AS launcher
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
CMD ["node", "src/launcher/main.ts"]

# プロキシ。ワーカーの通信を直接受けるので、使わないものを持たせない。
FROM app AS proxy
CMD ["node", "src/proxy/main.ts"]

# 事務局。git のある実行環境に、同じアプリのコードを入れる。
# 最後に置いて、対象を指定しないビルドの既定にする。
FROM runtime-git AS office
COPY --from=app /app /app
USER node
CMD ["node", "src/office/main.ts"]
