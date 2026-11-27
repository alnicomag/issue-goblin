#!/usr/bin/env bash
# イメージに付ける目印(作った元のコミット)を出す。
#
#   FACTORY_REVISION="$(scripts/revision.sh)" docker compose up -d --build
#
# 出すのは、このリポジトリの HEAD のコミット(40桁)。作業ツリーに未コミットの変更
# (Git管理外として無視されていない、未追跡のファイルを含む)があれば、末尾に -dirty を付ける。
set -euo pipefail

cd "$(dirname "$0")/.."

revision="$(git rev-parse --verify HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  revision="${revision}-dirty"
fi
printf '%s\n' "$revision"
