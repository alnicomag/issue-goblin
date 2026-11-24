# issue-goblin

GitHubのイシューを入力として、AIエージェントが実装からプルリクエストの作成までを進める「ソフトウェアファクトリー」です。

現在は段階1(ワーカー)で、次のことができます。

- 対象リポジトリのイシューとコメントをポーリングで取り込み、SQLiteに記録する。
- `state:` ラベルのない新規イシューに `state:triage` を付ける(`dry_run: false` のときだけ)。
- 対象リポジトリの `factory.yml` を取得して検証する。
- ワーカーを、資格情報のない隔離されたコンテナで動かす。
- 人間が `state:ready` にしたイシューに着手し、計画、実装、検査、レビューを経て、プルリクエストを作る(`dry_run: false` のときだけ)。分類と着手の判断(司令塔)は、まだない。

設計は `docs/design.md`、Dockerに関する用意(イメージの関係、作り直しの順、片付け)は `docs/docker.md`、段階0の仕様は `docs/stage0.md` にあります。

## 必要なもの

- Node 22.18 以上(TypeScriptをビルドせずに直接実行します)
- pnpm(`corepack enable pnpm` で使えます)
- Docker 26 以上と Docker Compose 2.24 以上(常駐させる場合)

## セットアップ

```bash
pnpm install --frozen-lockfile

cp config/factory.config.example.yml config/factory.config.yml
cp .env.example .env
```

`config/factory.config.yml` に対象リポジトリを書きます。

```yaml
dry_run: true              # true の間、GitHubへ一切書き込まない
poll_interval_sec: 60
db_path: /data/factory.db
repos_dir: /data/repos      # 事務局専用のミラーの置き場所(絶対パス)
work_dir: /work            # イシューごとの作業場所の置き場所(絶対パス)
repos:
  - repo: owner/name
    token_env: GITHUB_TOKEN_EXAMPLE   # トークンを入れた環境変数の名前
```

`.env` に、`token_env` で指定した名前でトークンを書きます。トークンは設定ファイルには書きません。

```bash
GITHUB_TOKEN_EXAMPLE=<トークン>
```

トークンは対象リポジトリだけに限定し、権限は次のとおりにします。

| 権限 | `dry_run: true` | `dry_run: false` |
| --- | --- | --- |
| Issues | 読み取り | 読み書き |
| Contents | 読み取り | 読み書き(作業用のブランチの push) |
| Pull requests | 不要 | 読み書き |

`config/factory.config.yml` と `.env` はGit管理外です。

### 製品のリポジトリに用意するラベル

対象のリポジトリに、次のラベルを作っておきます。対象のリポジトリを足すたびに行います。

事務局が付けるラベルは、付けるときにGitHubが自動で作ります。人間が画面から付けるラベルは、先に作っておかないと選べません。`state:` のラベルは、人間が手で状態を戻すときにも使うので、すべて先に作っておきます。

| ラベル | 意味 | 付ける人 |
| --- | --- | --- |
| `state:triage` | 新規、または再判定待ち | 事務局 |
| `state:needs-info` | 人間の回答や対応を待っている | 事務局 |
| `state:blocked` | 依存先のイシューが未完了 | 事務局(司令塔の指示による。段階1では付かない) |
| `state:ready` | 着手可能 | 人間(段階1)。再試行に戻すときは事務局 |
| `state:in-progress` | ワーカーが作業中 | 事務局 |
| `state:in-review` | PR作成済み | 事務局 |
| `state:failed` | 試行上限に達した | 事務局 |
| `priority:p0`、`priority:p1`、`priority:p2`、`priority:p3` | 優先度。`p0` が最も高い | 人間 |
| `size:s`、`size:m`、`size:l` | 大きさ | 人間 |
| `agent:skip` | エージェントは触らない | 人間 |
| `agent:approved` | 保護対象のパスに触れる変更の承認 | 人間(事務局が、受け取ったときに外す) |

意味と遷移の詳しい説明は、[docs/design.md](docs/design.md) の「イシューの状態と遷移」にあります。食い違う場合は、`docs/design.md` を正とします。

作り方の例です。`owner/name` は対象のリポジトリに読み替えます。`--force` を付けているので、すでにあるラベルがあっても失敗せず、何度実行しても同じ結果になります。

```bash
for label in \
  state:triage state:needs-info state:blocked state:ready \
  state:in-progress state:in-review state:failed \
  priority:p0 priority:p1 priority:p2 priority:p3 \
  size:s size:m size:l \
  agent:skip agent:approved
do
  gh label create "$label" --repo owner/name --force
done
```

### ワーカーの実行環境

ワーカーは、事務局とは別のコンテナで動きます。コンテナを立てるのは「起動係」で、事務局は起動係に依頼します。仕組みは `docs/design.md` の「ワーカーの封じ込め」にあります。

1. `.env` に、ホストの docker グループの番号を書きます。起動係がDockerソケットを使うために要ります。

   ```bash
   echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" >> .env
   ```

2. Claudeのトークンを、起動係だけが読むファイルに書きます。事務局の `.env` には書きません。

   ```bash
   cp .env.launcher.example .env.launcher
   claude setup-token        # 発行された値を .env.launcher に書く
   ```

3. ワーカーのイメージを作ります。

   ```bash
   docker compose build worker-image
   ```

   イメージの名前は、設定(`config/factory.config.yml`)の `worker_image` で決めます。既定は `factory-worker` で、そのまま使うなら、ほかに書くものはありません。別の名前にするときは、設定の `worker_image` に書いたうえで、ビルドで同じ名前が付くように、`.env` の `WORKER_IMAGE` にも同じ値を書きます。

   起動係は、起動のときに、設定にあるイメージ(全体と、製品ごと)が手元にあるかを確かめます。なければ、ログに `launcher.image_missing` を出します(`image` がないイメージ、`repos` がそれを使う製品)。起動係は止まらず、イメージのある製品の実行は続きます。

   ```bash
   docker compose logs launcher | grep launcher.image_missing
   ```

   確かめるのは起動のときだけです。後からイメージを作った場合、再起動は要りません(次のステップから使われます)。

製品に固有のツール(検査コマンドが使うもの)が要る場合は、製品リポジトリに Dockerfile を置き、製品の `factory.yml` にその場所を書きます。どのツールが要るかは、検査コマンドと同じく製品の知識だからです。ファクトリーが、基本のイメージを土台にして、そこからワーカーのイメージをビルドします。手でビルドする必要はありません。

```yaml
# 製品リポジトリの factory.yml
worker:
  dockerfile: .factory/worker.Dockerfile
```

```dockerfile
# 製品リポジトリの .factory/worker.Dockerfile
ARG FACTORY_BASE_IMAGE
FROM ${FACTORY_BASE_IMAGE}
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends <ツール> \
  && rm -rf /var/lib/apt/lists/*
USER node
```

Dockerfile の書き方には、決まりがあります。

- 基本のイメージの名前は、ビルド引数で受け取ります(`ARG FACTORY_BASE_IMAGE` と `FROM ${FACTORY_BASE_IMAGE}`)。ファクトリーの手元の名前を、製品には書きません。`FROM` に、ほかのイメージは書けません。
- 最後に、基本のイメージと同じユーザー(`USER node`)に戻します。
- ビルドに渡るのは、Dockerfile 1枚だけです。製品のほかのファイルは渡らないので、`COPY` で入れることはできません(前の段からの `COPY --from=<段の名前>` は使えます)。`ADD` は使えません。
- ビルドの通信は、ワーカーと同じプロキシを通ります。通るのは、443番へのHTTPSだけです。基本のイメージの apt は、取得元をHTTPSにしてあるので、`apt-get` はそのまま使えます。
- 旧ビルダーでビルドするので、`RUN --mount` とヒアドキュメントは使えません。
- 場所(`worker.dockerfile`)に使えるのは、英数字と `.`、`_`、`-`、`/` だけです。

ファクトリーの側の動きは、次のとおりです(決めた理由は `docs/design.md` の「製品のイメージのビルド」)。

- **使うのは、既定ブランチの Dockerfile だけです。** 作業用のブランチでワーカーが書き換えても、その実行のイメージは変わりません。Dockerfile のパスは、`paths.protected` に書いていなくても、変更に人間の承認が要るパスとして扱います。
- **ビルドは、起動係が、必要なときに行います。** Dockerfile か基本のイメージが変わると、次の実行の前にビルドし直します。変わらなければ、ビルドしません。古いイメージは、ビルドし直したときに消します。
- **ビルドに失敗した製品には、着手しません。** 理由は、状況表示(`pnpm run status`)と、ログ(`preflight.failed`)に出ます。

```bash
docker image ls --filter label=factory.repo=owner/name   # ビルドされた、製品のイメージ
```

`factory.yml` に `worker.dockerfile` を書かない製品は、設定(`config/factory.config.yml`)の `worker_image` のイメージで、そのまま動きます。手でビルドしたイメージを使いたい場合は、製品ごとに `worker_image` を書けます。`worker.dockerfile` と両方を書いた場合は、`worker_image` のイメージが、ビルドの土台になります。

```yaml
worker_image: factory-worker          # 既定のイメージ
repos:
  - repo: owner/name
    token_env: GITHUB_TOKEN_EXAMPLE
    worker_image: owner-name-worker   # 省略可。この製品だけ別のイメージにする
```

`.env.launcher` もGit管理外です。

## 起動

```bash
docker compose up -d --build
docker compose logs -f office
```

常駐するコンテナは3つです。

| コンテナ | 役割 | 持っているもの |
| --- | --- | --- |
| `office` | 事務局 | GitHubのトークン、DB |
| `launcher` | 起動係。事務局の依頼で、ワーカーのコンテナを立てる | Dockerソケット、Claudeのトークン |
| `proxy` | ワーカーの唯一の出口。内部宛ての通信を拒否する | なし |

- 起動時にマイグレーションを実行します。未適用のものがあれば、適用前にDBファイルを同じ場所に複製します(`factory.db.bak-v<版>-<日時>`)。
- DBファイルは名前付きボリューム `factory-data` に置かれます。
- `restart: unless-stopped` なので、ホストの再起動後も自動で復旧します。Dockerが起動時に立ち上がるようにしておいてください(`sudo systemctl enable docker`)。
- 停止は `docker compose stop` です。実行中のポーリングを終えてから終了します。ワーカーが実行中のステップは待たずに止め、次の起動でそのステップからやり直します(試行には数えません)。
- ログは1行1件のJSONです。

設定を変えたときは、`docker compose restart office` で読み直します。`worker_image` を変えたときは、起動係も読み直します(`docker compose restart office launcher`)。起動係は、読み直した設定のイメージが手元にあるかを確かめ、なければログに出します(`launcher.image_missing`)。

### GitHubへの書き込みを有効にする

`dry_run` を `false` にすると、`state:` ラベルのないオープンのイシューに `state:triage` が付きます。`true` の間は、付ける予定だったことをログに出すだけです(`github.write_skipped`)。

`dry_run` が `false` の間は、`state:ready` のイシューに着手します。`true` の間は、着手も、途中の実行を進めることもしません(ラベルを書けないと、GitHubから見えないところで作業が進むためです)。`true` の間は、着手するはずだったイシューを、ログに出します(`intake.held`)。同じイシューは、着手の対象である間、1回だけ出ます(事務局を起動し直すと、もう1回出ます)。

着手するのは、次をすべて満たすイシューです。順は、`priority:` の高い順、同じなら番号の若い順です。

- 状態が `state:ready` で、`agent:skip` が付いていない。
- 起票者が、製品の `factory.yml` の `issues.allowed_authors` にいる。
- 同時実行の枠(`limits.max_parallel`)と、1日の実行数の上限(`daily_run_limit`、UTCの1日、全リポジトリの合計)に収まる。
- 失敗の後の待機時間(`retry_wait_minutes`)が過ぎている。

実行中に人間が `state:` ラベルを変えると、事務局は実行を取り消して、その状態に従います。

## ワーカーの隔離を確かめる

ワーカーから見えるもの、できること、届く先を、実際にコンテナを立てて確かめます。あわせて、事務局のコンテナで作業場所の準備と後片付けが通ること、検査コマンドの実行(verify)、ワーカーのイメージのgitが設定の作者をそのままコミットに書くことを確かめます。

```bash
scripts/check-isolation.sh
```

- 確認用の環境を、稼働中のものとは別の名前(`factory-check`)で立て、終わったら消します。稼働中のファクトリーや、同じホストのほかのコンテナには触れません。
- GitHubのトークンとClaudeのトークンには、その場で作った仮の値を使います。実際のトークンは読みません。
- 項目ごとに `OK` か `NG` を出し、1つでも `NG` があれば終了コード1で終わります。
- 外部への接続の確認で、`github.com` に接続します(公開リポジトリの読み取りと、認証のない `git push` の失敗)。

確かめる内容は次のとおりです。

| 分類 | 確かめること |
| --- | --- |
| 見えるもの | 事務局のDBファイル、`.env`、設定ファイル、ソケットを読めない。環境変数が明示した一覧だけである。マウントが作業場所だけである。ほかのイシューとほかの製品の作業場所が見えない |
| できること | 作業場所でファイルの変更とコミットができる。作業場所の外に書けない。`git push` が認証できずに失敗する。`gh` がない |
| 届く先 | インスタンスメタデータ、ホスト、ほかのコンテナに、直接にもプロキシ経由でも届かない。プロキシを通して外部のHTTPSに届く |
| トークン | Claudeのトークンが、求めた実行にだけ渡る。事務局の環境、ログ、作業場所に含まれない |
| 起動係 | 事務局がDockerソケットを持たない。不正な依頼を拒否する。時間の上限を過ぎた実行を止める。コンテナを残さない |
| 事務局のgit | 事務局のコンテナにgitがあり、作業場所の準備(prepare)と後片付け(cleanup)が通る。起動係とプロキシのコンテナにはgitがない |
| 検査コマンド | verify が、製品のコマンドを作業場所で順に実行し、合否、終了コード、所要時間を記録する。コンテナに事務局の環境変数とClaudeのトークンが渡らない。時間切れのコマンドが止まり、不合格になる。ログでトークンが伏せられる |
| 製品のイメージのビルド | `worker.dockerfile` を書いた製品の Dockerfile を実際にビルドし、ワーカーと verify がそのイメージで動く。ビルドの環境(`RUN` の中)に、GitHubのトークン、Claudeのトークン、DB、ソケット、作業場所がない。ビルドから、インスタンスメタデータ、ホスト、ほかのコンテナに、直接にもプロキシ経由でも届かない。変わらなければビルドし直さない。作業用のブランチの Dockerfile は使われない。`ADD` やほかのイメージを使う Dockerfile は断る。プロキシを通して apt を使える。古いイメージが残らない |
| コミットの作者 | 設定の検証を通る作者の例(`scripts/commit-author-examples.ts`)それぞれについて、ワーカーのイメージのgitで作ったコミットの作者とコミッターが、設定の値と完全に一致する。一致しなければ、設定の値とコミットに書かれた値を出す |

環境を残して調べたいときは、`CHECK_KEEP=1 scripts/check-isolation.sh` で実行します。

## 状況表示

リポジトリごとに、状態別のイシュー数、未処理のイベント数、最後に同期した時刻、着手前の確認の結果を表示します。
着手前の確認は、製品の `commands.setup` がワーカーのイメージで通るかを、着手の前に確かめるものです。通らなかった製品には着手しません。その場合は、コマンド、終了コード、出力の末尾、ログの場所、次に確かめ直す条件が出ます(`docs/design.md` の「着手前の確認」)。
続けて、全体について次を表示します。DBは読み取り専用で開き、何も書き換えません。

- 当日(UTC)に開始した実行の数と、上限(`daily_run_limit`)。着手のときと同じ数え方です。
- 進行中の実行(リポジトリ、イシュー番号、試行回数、現在のステップ、開始時刻)。ステップの合間にある実行は、次に行うステップを出します。
- クローズ待ちの実行。PRの作成まで終わり、イシューのクローズを待っているだけの実行です。同時実行の枠には数えません。
- 再試行を待っているイシューと、再試行してよい時刻。失敗の後、待機時間が過ぎていないものです。

```bash
docker compose exec office node src/office/status.ts
```

Dockerを使わずに動かしている場合は、次のコマンドです。

```bash
pnpm run status
```

## 段階1を通して確かめる

実際のリポジトリで、`state:ready` のイシュー1件がPRになるまでを確かめる手順です。`owner/name` は対象のリポジトリ、`<番号>` はイシューの番号に読み替えます。

### 1. 準備

- 対象のリポジトリに、「製品のリポジトリに用意するラベル」のとおりにラベルを作ります。`state:ready` は人間が手で付けるので、先に作っておかないと選べません。
- 対象のリポジトリに `factory.yml` を置き、小さなイシューを1件用意します。起票者は `issues.allowed_authors` に入れます。
- 製品の検査コマンドに要るツールが、ワーカーのイメージに入っていることを確かめます。基本のイメージにあるのは、Node、git、Claude Code だけです。足りなければ、「ワーカーの実行環境」のとおりに、製品リポジトリに Dockerfile を置き、`factory.yml` の `worker.dockerfile` に場所を書きます。

  ```bash
  docker run --rm --entrypoint sh <イメージ> -c '<ツール> --version'
  ```

  ワーカーのコンテナは、ルートが読み取り専用で、書けるのは作業場所(`HOME` を含む)と `/tmp` だけです。実行時にツールを入れる作りにはせず、イメージに入れておきます。

  足りないまま `dry_run: false` で動かした場合も、事務局が着手の前に `commands.setup` を実行して確かめるので、通らなければ着手しません。理由は、状況表示の「着手前の確認」に出ます。
- 稼働中のイメージが、手元のコードから作ったものであることを確かめます。古ければ `docker compose up -d --build` で作り直します。

### 2. `dry_run: true` で動かす

`dry_run: true` のまま起動し、ポーリングを数回待ちます。前後で、イシュー、PR、ブランチに変化がないことを確かめます。

```bash
gh issue list -R owner/name --state all --json number,state,labels,updatedAt,comments
gh pr list -R owner/name --state all --json number,state,headRefName,updatedAt
gh api repos/owner/name/branches --jq '.[].name'
docker compose logs office | grep -c '"github.write"'    # 0 であること
```

`dry_run: true` の間は、`state:ready` のイシューがあっても着手しません。

### 3. `dry_run: false` で動かす

GitHubへ実際に書き込みます。イシューを手動で `state:ready` にし、`dry_run` を `false` にして、`docker compose restart office` で読み直します。

```bash
docker compose logs -f office
docker compose exec office node src/office/status.ts
```

ログには、次の順でイベントが出ます。

| イベント | 意味 |
| --- | --- |
| `run.started` | 着手した |
| `transition.applied`(`ready` から `in-progress`) | ラベルを付け替えた |
| `run.step_started`、`run.step_finished` | ステップ(`prepare`、`plan`、`implement`、`verify`、`review`、`publish`)の開始と終了 |
| `publish.finished` | ブランチを push し、PRを作った(または更新した) |
| `run.paused`(`waiting_close`) | PRまで終わり、イシューのクローズを待っている |
| `transition.applied`(`in-progress` から `in-review`) | 次のポーリングでラベルを付け替えた |

確かめ終えたら、`dry_run` を `true` に戻して読み直します。

### 4. 途中で止めて、続きから進むことを確かめる

ステップの途中で事務局を止め、起動し直します。

```bash
docker compose stop office
docker ps --filter label=factory.worker    # ワーカーのコンテナが残っていないこと
docker compose start office
```

- 止めたとき、ログに `run.paused`(`aborted`)と `office.stopped` が出ます。実行と、そのステップは、DBに `running` のまま残ります。
- 起動し直すと、最初の同期の後に、同じステップが `"resumed":true` で始まります。試行回数は増えません。
- `publish` の途中で止めた場合も、起動し直した後のPRは1つのままです。PRがすでにあれば、作らずに更新します(`"pr_created":false`)。

```bash
gh pr list -R owner/name --state all --head agent/issue-<番号>    # 1件であること
```

### 5. 実行の記録を見る

`steps` に、ステップごとの結果、費用、ログの場所が入ります。費用とログがあるのは、Claudeを呼ぶステップ(`plan`、`implement`、`review`)と `verify`(ログだけ)です。

```bash
docker compose exec office node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/factory.db", { readOnly: true });
console.table(db.prepare("SELECT id, repo, issue_number, attempt, status, current_step, pr_number FROM runs").all());
console.table(db.prepare("SELECT run_id, name, status, cost_usd, log_path, started_at, finished_at FROM steps ORDER BY id").all());
'
```

PRまで終わった実行は、イシューがクローズされるまで `running`(`current_step` は `publish`)のまま残ります。状況表示では「クローズ待ちの実行」に出ます。

ログは、事務局のコンテナの `logs_dir`(既定は `/data/logs`)の下にあります。

```bash
docker compose exec office ls /data/logs/owner/name/issue-<番号>
```

### 6. トークンが漏れていないことを確かめる

`.env` と `.env.launcher` の値を、DB、ログ、ミラー、作業場所、コンテナのログから探します。値は画面に出しません。どの行も、件数が 0 であることを確かめます。

```bash
umask 077
grep -hE '^[A-Z_]*(TOKEN|KEY)[A-Z_]*=' .env .env.launcher | sed 's/^[^=]*=//' > /tmp/factory-secrets
docker run --rm --network none --user 0 --entrypoint sh \
  -v "$(docker compose config --format json | jq -r .name)_factory-data:/data:ro" \
  -v "$(docker compose config --format json | jq -r .name)_factory-work:/work:ro" \
  -v /tmp/factory-secrets:/secrets:ro \
  factory-worker -c 'grep -ralF -f /secrets /data /work | wc -l'
for c in office launcher proxy; do
  docker compose logs --no-log-prefix "$c" | grep -cF -f /tmp/factory-secrets
done
rm /tmp/factory-secrets
```

### 7. ワーカーの環境からGitHubへ書けないことを確かめる

実行後の作業場所は、イシューがクローズされるまで残ります。これを、ワーカーと同じ条件のコンテナにマウントして確かめます。

```bash
project="$(docker compose config --format json | jq -r .name)"
docker run --rm --pull=never --network="${project}_workers" --user=1000:1000 \
  --cap-drop=ALL --security-opt=no-new-privileges --read-only --tmpfs=/tmp \
  --mount="type=volume,src=${project}_factory-work,dst=/workspace,volume-subpath=owner/name/issue-<番号>" \
  --workdir=/workspace/repo --env=HOME=/workspace/home \
  --env=HTTPS_PROXY=http://proxy:3128 --env=https_proxy=http://proxy:3128 \
  --env=GIT_TERMINAL_PROMPT=0 --entrypoint sh <イメージ> -c '
    git remote -v
    ls -a "$HOME"
    git push https://github.com/owner/name.git HEAD:refs/heads/factory-push-probe
  '
```

- `git remote -v` が何も出さない(作業場所にリモートがない)。
- `HOME` に `.git-credentials`、`.netrc`、`.ssh` がない。
- `git push` が、認証できずに失敗する(`could not read Username`)。GitHub上に `factory-push-probe` というブランチができていないことも確かめます。

実行の前の状態で同じことを確かめるには、`scripts/check-isolation.sh` を使います。

## Dockerを使わずに動かす

`db_path` を手元のパス(例: `./data/factory.db`)に、`repos_dir` と `work_dir` を手元の絶対パスにして、トークンを環境変数に入れて起動します。

```bash
GITHUB_TOKEN_EXAMPLE=<トークン> pnpm start
```

設定ファイルの場所は、環境変数 `FACTORY_CONFIG` で変えられます(既定は `config/factory.config.yml`)。

## テスト

```bash
pnpm run typecheck
pnpm run lint
pnpm test
```

テストはネットワークに出ません。GitHubは偽の実装(`tests/fake-github.ts`)に差し替えています。

## 開発の進め方

開発はイシュー駆動で進めます。

- イシューには `type:` のラベルを必ず1つ、`scope:` のラベルを当てはまれば1つ付けます。軸と値の一覧は `CLAUDE.md` にあります。
- コミットとPRのタイトルは Conventional Commits の形(`<型>(<範囲>): <要約>`)にし、型と範囲をイシューのラベルに合わせます。
- Claude Code でイシューに着手するときは、`/issue <番号>` を使います。

## 構成

| 場所 | 内容 |
| --- | --- |
| `src/office/main.ts` | 起動とメインループ |
| `src/office/config.ts` | ファクトリー側の設定 |
| `src/office/db.ts` | SQLiteとマイグレーション |
| `src/office/github.ts` | GitHubクライアント(読み取りと書き込みをここに集約) |
| `src/office/sync.ts` | 同期の処理 |
| `src/office/transitions.ts` | 遷移表 |
| `src/office/product.ts` | `factory.yml` の取得と検証 |
| `src/office/preflight.ts` | 着手前の確認(`commands.setup` がワーカーのイメージで通るか) |
| `src/office/status.ts` | 状況表示コマンド |
| `src/office/events.ts` | イベントの記録 |
| `src/office/log.ts` | 構造化ログ |
| `src/office/clock.ts` | 時計 |
| `src/launcher/` | 起動係と、事務局から起動係に依頼する口 |
| `src/proxy/` | ワーカーの出口になるプロキシ |
| `docker/worker.Dockerfile` | ワーカーの基本イメージ |
| `scripts/` | 確認用のスクリプト |
| `migrations/` | 連番のSQLファイル |
| `config/` | ファクトリー側の設定の例 |
| `tests/` | 自動テスト |
| `.claude/skills/` | 開発で使うスキル(`/issue`) |
| `.github/` | イシューとPRのテンプレート |
