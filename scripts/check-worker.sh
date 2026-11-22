#!/usr/bin/env bash
# ワーカーの呼び出しを、実際にClaudeを呼んで確かめる。
#
# 確認用の環境を、稼働中のものとは別の名前(既定: factory-worker-check)で立て、終わったら消す。
# 稼働中のファクトリーや、同じホストのほかのコンテナには触れない。
#
# 実際のClaudeのトークンを使い、小さな呼び出しを3回行う(サブスクリプションの枠を少し使う)。
# トークンは、起動係の環境変数のファイルから起動係にだけ渡す。GitHubのトークンには仮の値を使う。
#
# 使い方: scripts/check-worker.sh
#   CHECK_PROJECT        確認用の環境の名前(既定: factory-worker-check)
#   CHECK_LAUNCHER_ENV   起動係の環境変数のファイル(既定: .env.launcher)
#   CHECK_KEEP=1         終わっても環境を消さない(ログを読みたいとき)
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${CHECK_PROJECT:-factory-worker-check}"
LAUNCHER_ENV="$(realpath "${CHECK_LAUNCHER_ENV:-.env.launcher}")"
TOKEN_NAME=CLAUDE_CODE_OAUTH_TOKEN
TMP="$(mktemp -d)"

compose() {
  docker compose -p "$PROJECT" --env-file "$TMP/compose.env" "$@"
}

# 確認用の環境に属さないものの一覧。前後で変わっていないことを確かめる。
others() {
  {
    docker ps --all --format 'container {{.Names}} {{.Image}} {{.State}}'
    docker network ls --format 'network {{.Name}}'
    docker volume ls --format 'volume {{.Name}}'
  } | grep -v -e " ${PROJECT}[-_]" | sort
}

cleanup() {
  status=$?
  if [ "${CHECK_KEEP:-}" = "1" ]; then
    echo "確認用の環境を残しました(消すには: docker compose -p $PROJECT down --volumes)"
  else
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    docker image rm "${PROJECT}-office" "${PROJECT}-launcher" "${PROJECT}-proxy" \
      "${PROJECT}-worker" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

if [ -n "$(docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT")" ]; then
  echo "「$PROJECT」という名前の環境が、すでにあります。別の名前を CHECK_PROJECT に指定してください。" >&2
  trap - EXIT
  rm -rf "$TMP"
  exit 1
fi

# トークンは、ログと作業場所に残っていないことを確かめるためにだけ読む。画面には出さない。
CLAUDE_TOKEN="$(sed -n "s/^${TOKEN_NAME}=//p" "$LAUNCHER_ENV" 2>/dev/null | tail -n 1 | tr -d '"'"'"'\r')"
if [ "${#CLAUDE_TOKEN}" -lt 20 ]; then
  echo "$LAUNCHER_ENV に ${TOKEN_NAME} がありません(claude setup-token で発行した値を書いてください)。" >&2
  exit 1
fi
export CLAUDE_TOKEN

random() { od -An -N12 -tx1 /dev/urandom | tr -d ' \n'; }

cat >"$TMP/config.yml" <<CONFIG
dry_run: true
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
logs_dir: /data/logs
worker_image: ${PROJECT}-worker
repos:
  - repo: owner/name
    token_env: GITHUB_TOKEN_CHECK
CONFIG
printf 'GITHUB_TOKEN_CHECK=dummy-github-%s\n' "$(random)" >"$TMP/office.env"
cat >"$TMP/compose.env" <<ENV
FACTORY_CONFIG_FILE=$TMP/config.yml
FACTORY_ENV_FILE=$TMP/office.env
LAUNCHER_ENV_FILE=$LAUNCHER_ENV
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
WORKER_IMAGE=${PROJECT}-worker
ENV

others >"$TMP/before.txt"

echo "# イメージを作る"
compose build --quiet office launcher proxy worker-image

echo "# 起動係とプロキシを立てる"
compose up --detach --no-build launcher proxy >/dev/null 2>&1

# 起動係がソケットを開くのを待つ。
for _ in $(seq 1 30); do
  if compose logs launcher 2>/dev/null | grep -q '"launcher.started"'; then break; fi
  sleep 1
done

result=0

echo "# ワーカーを呼び出して調べる"
echo
compose run --rm --no-deps -T office node scripts/worker-check.ts 2>&1 || result=1

echo
echo "# 実行の後の状態"
check() {
  if [ "$1" = "0" ]; then echo "OK  $2"; else echo "NG  $2"; result=1; fi
}

leftovers="$(docker ps --all --quiet --filter "label=factory.worker=${PROJECT}_factory-work" | wc -l)"
check "$([ "$leftovers" = "0" ] && echo 0 || echo 1)" "ワーカーのコンテナが残っていない"

# トークンの値は、引数ではなく環境変数で渡す(引数は、プロセスの一覧から見える)。
contains_token() {
  docker run --rm --env CLAUDE_TOKEN --volume "$1:/target:ro" busybox:1.37 \
    sh -c 'grep -r -q -F -e "$CLAUDE_TOKEN" /target'
}

if docker run --rm --volume "${PROJECT}_factory-data:/data:ro" busybox:1.37 \
  sh -c 'ls /data/logs/owner/name/issue-*/*.log >/dev/null 2>&1'; then
  check 0 "ログのファイルが、事務局のデータの置き場所にある"
else
  check 1 "ログのファイルが、事務局のデータの置き場所にある"
fi
if contains_token "${PROJECT}_factory-data"; then
  check 1 "ワーカーのログに、トークンが含まれない"
else
  check 0 "ワーカーのログに、トークンが含まれない"
fi
if contains_token "${PROJECT}_factory-work"; then
  check 1 "作業場所に、トークンが含まれない"
else
  check 0 "作業場所に、トークンが含まれない"
fi
if compose logs --no-color launcher proxy 2>&1 | grep -q -F -e "$CLAUDE_TOKEN"; then
  check 1 "起動係とプロキシのログに、トークンが含まれない"
else
  check 0 "起動係とプロキシのログに、トークンが含まれない"
fi

others >"$TMP/after.txt"
if diff "$TMP/before.txt" "$TMP/after.txt" >/dev/null; then
  check 0 "確認用の環境のほかには、コンテナ、ネットワーク、ボリュームを変えていない"
else
  diff "$TMP/before.txt" "$TMP/after.txt" || true
  check 1 "確認用の環境のほかには、コンテナ、ネットワーク、ボリュームを変えていない"
fi

echo
if [ "$result" = "0" ]; then
  echo "ワーカーの呼び出しの確認は、すべて合格しました"
else
  echo "ワーカーの呼び出しの確認に、不合格があります" >&2
fi
exit "$result"
