# ワーカーの基本イメージ。
#
# 計画、実装、レビュー(Claude Code)と、製品の検査コマンドを、この中で実行する。
# 資格情報を扱う道具(gh など)は入れない。製品に固有のツールが要る場合は、
# このイメージを土台にした別のイメージを作り、設定の worker_image で指定する。
FROM node:22-slim

# Claude Code の版は固定する。フラグの挙動が、気づかないうちに変わらないようにするため。
ARG CLAUDE_CODE_VERSION=2.1.330

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

# 事務局の実行ユーザーと同じuid(1000)。作業場所の所有者をそろえる。
USER node
WORKDIR /workspace
