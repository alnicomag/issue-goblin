#!/usr/bin/env bash
# ワーカーの隔離を、実際にコンテナを立てて確かめる。
# あわせて、事務局のコンテナで作業場所の準備と後片付けが通ることを確かめる。
#
# 確認用の環境を、稼働中のものとは別の名前(既定: factory-check)で立て、終わったら消す。
# 稼働中のファクトリーや、同じホストのほかのコンテナには触れない。
# GitHubのトークンとClaudeのトークンには、その場で作った仮の値を使う。
#
# 使い方: scripts/check-isolation.sh
#   CHECK_PROJECT      確認用の環境の名前(既定: factory-check)
#   CHECK_KEEP=1       終わっても環境を消さない(調べたいとき)
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${CHECK_PROJECT:-factory-check}"
LISTENER="${PROJECT}-listener"
LISTENER_PORT=18765
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
    docker rm --force "$LISTENER" >/dev/null 2>&1 || true
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

random() { od -An -N12 -tx1 /dev/urandom | tr -d ' \n'; }
GITHUB_DUMMY="dummy-github-$(random)"
CLAUDE_DUMMY="dummy-claude-$(random)"
CLAUDE_DUMMY_SHA256="$(printf '%s' "$CLAUDE_DUMMY" | sha256sum | cut -d' ' -f1)"

cat >"$TMP/config.yml" <<CONFIG
dry_run: true
db_path: /data/factory.db
repos_dir: /data/repos
work_dir: /work
worker_image: ${PROJECT}-worker
repos:
  - repo: owner/first
    token_env: GITHUB_TOKEN_CHECK
  - repo: owner/second
    token_env: GITHUB_TOKEN_CHECK
CONFIG
printf 'GITHUB_TOKEN_CHECK=%s\n' "$GITHUB_DUMMY" >"$TMP/office.env"
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_DUMMY" >"$TMP/launcher.env"
cat >"$TMP/compose.env" <<ENV
FACTORY_CONFIG_FILE=$TMP/config.yml
FACTORY_ENV_FILE=$TMP/office.env
LAUNCHER_ENV_FILE=$TMP/launcher.env
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
WORKER_IMAGE=${PROJECT}-worker
ENV

others >"$TMP/before.txt"

echo "# イメージを作る"
compose build --quiet office launcher proxy worker-image

echo "# 起動係とプロキシを立てる"
compose up --detach --no-build launcher proxy >/dev/null 2>&1
# 事務局のネットワークだけを先に作る(事務局そのものは常駐させない)。
compose up --no-start --no-build office >/dev/null 2>&1

# ホストと、ほかのコンテナの代わりになる待ち受け。
# Dockerの既定のブリッジのゲートウェイ(ホストのアドレスの1つ)にだけ公開する。
HOST_IP="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
docker run --detach --rm --name "$LISTENER" \
  --publish "${HOST_IP}:${LISTENER_PORT}:8080" busybox:1.37 httpd -f -p 8080 >/dev/null
# 事務局と同じネットワークにもつなぎ、「ほかのコンテナ」としての宛先にする。
docker network connect "${PROJECT}_default" "$LISTENER"
LISTENER_IP="$(docker inspect "$LISTENER" --format "{{(index .NetworkSettings.Networks \"${PROJECT}_default\").IPAddress}}")"

# 起動係がソケットを開くのを待つ。
for _ in $(seq 1 30); do
  if compose logs launcher 2>/dev/null | grep -q '"launcher.started"'; then break; fi
  sleep 1
done

result=0

echo "# 事務局のコンテナで、作業場所の準備と後片付けを調べる"
echo
compose run --rm --no-deps -T office node scripts/workspace-check.ts 2>&1 || result=1
echo

echo "# ワーカーを立てて調べる"
echo
compose run --rm --no-deps -T \
  --env "CHECK_HOST_ADDR=${HOST_IP}:${LISTENER_PORT}" \
  --env "CHECK_HOST_IP=${HOST_IP}" \
  --env "CHECK_CONTAINER_ADDR=${LISTENER_IP}:8080" \
  --env "CHECK_CLAUDE_TOKEN_SHA256=${CLAUDE_DUMMY_SHA256}" \
  office node scripts/isolation-check.ts 2>&1 || result=1

echo
echo "# 実行の後の状態"
check() {
  if [ "$1" = "0" ]; then echo "OK  $2"; else echo "NG  $2"; result=1; fi
}

leftovers="$(docker ps --all --quiet --filter "label=factory.worker=${PROJECT}_factory-work" | wc -l)"
check "$([ "$leftovers" = "0" ] && echo 0 || echo 1)" "ワーカーのコンテナが残っていない"

logs="$(compose logs --no-color launcher proxy 2>&1)"
if printf '%s' "$logs" | grep -q -e "$GITHUB_DUMMY" -e "$CLAUDE_DUMMY"; then
  check 1 "起動係とプロキシのログに、トークンが含まれない"
else
  check 0 "起動係とプロキシのログに、トークンが含まれない"
fi

if docker run --rm --volume "${PROJECT}_factory-work:/work:ro" busybox:1.37 \
  grep -r -q -e "$GITHUB_DUMMY" -e "$CLAUDE_DUMMY" /work; then
  check 1 "作業場所に、トークンが含まれない"
else
  check 0 "作業場所に、トークンが含まれない"
fi

# gitが要るのは事務局だけ。起動係とプロキシには持たせない。
for service in launcher proxy; do
  if compose exec -T "$service" sh -c 'command -v git' >/dev/null 2>&1; then
    check 1 "${service} のコンテナに、gitが入っていない"
  else
    check 0 "${service} のコンテナに、gitが入っていない"
  fi
done

launcher_env="$(compose exec -T launcher env)"
if printf '%s' "$launcher_env" | grep -q -e "$GITHUB_DUMMY" -e '^GITHUB'; then
  check 1 "起動係の環境変数に、GitHubのトークンがない"
else
  check 0 "起動係の環境変数に、GitHubのトークンがない"
fi

office_mounts="$(compose config --format json | docker run --rm -i --entrypoint node "${PROJECT}-office" -e '
  let text = ""; process.stdin.on("data", (d) => (text += d)); process.stdin.on("end", () => {
    const volumes = JSON.parse(text).services.office.volumes ?? [];
    console.log(volumes.map((v) => v.source).join("\n"));
  });')"
if printf '%s' "$office_mounts" | grep -q 'docker.sock'; then
  check 1 "事務局のコンテナの定義に、Dockerソケットのマウントがない"
else
  check 0 "事務局のコンテナの定義に、Dockerソケットのマウントがない"
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
  echo "隔離の確認は、すべて合格しました"
else
  echo "隔離の確認に、不合格があります" >&2
fi
exit "$result"
