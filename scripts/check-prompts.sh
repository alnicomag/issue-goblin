#!/usr/bin/env bash
# 指示書(plan、implement、review)を、実際にClaudeを呼んで確かめる。
#
# 確認用の環境を、稼働中のものとは別の名前(既定: factory-prompts-check)で立て、終わったら消す。
# 環境の立て方と後始末は scripts/check-worker.sh と同じで、中で実行する確認だけが違う。
#
# 仮の小さな製品と小さなイシューで、3つの指示書を順に1回ずつ呼び出す
# (サブスクリプションの枠を使う。数分かかる)。
#
# 使い方: scripts/check-prompts.sh
#   CHECK_PROJECT、CHECK_LAUNCHER_ENV、CHECK_KEEP は、scripts/check-worker.sh と同じ。
set -euo pipefail

cd "$(dirname "$0")/.."

export CHECK_PROJECT="${CHECK_PROJECT:-factory-prompts-check}"
exec scripts/check-worker.sh scripts/prompts-check.ts
