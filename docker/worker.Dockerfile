# ワーカーの基本イメージ。
#
# 計画、実装、レビュー(Claude Code)と、製品の検査コマンドを、この中で実行する。
# 資格情報を扱う道具(gh など)は入れない。製品に固有のツールが要る場合は、
# 製品が自分のリポジトリに Dockerfile を置き、factory.yml の worker.dockerfile に場所を書く。
# 起動係が、このイメージを土台にしてビルドする(docs/design.md の「製品のイメージのビルド」)。
FROM node:22-slim

# Claude Code の版は固定する。フラグの挙動が、気づかないうちに変わらないようにするため。
ARG CLAUDE_CODE_VERSION=2.1.330

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# apt の取得元を、HTTPSにする。製品の Dockerfile のビルドは、ワーカーと同じプロキシを通り、
# プロキシは443番への接続しか通さない。平文のHTTPのままだと、製品の側の apt-get が失敗する。
RUN sed -i 's|^URIs: http://deb.debian.org/|URIs: https://deb.debian.org/|' \
    /etc/apt/sources.list.d/debian.sources \
  && ! grep -q '^URIs: http://' /etc/apt/sources.list.d/debian.sources

RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

# 事務局の実行ユーザーと同じuid(1000)。作業場所の所有者をそろえる。
USER node
WORKDIR /workspace

# 作った元のコミット(scripts/revision.sh の出力)。渡さなければ空で、目印は「不明」になる。
# ラベルは、このイメージを土台にした製品用のイメージにも引き継がれる。
ARG FACTORY_REVISION=
LABEL factory.revision=$FACTORY_REVISION
