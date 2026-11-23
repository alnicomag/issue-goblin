# issue-goblin

GitHubのイシューを入力として、AIエージェントが実装からプルリクエストの作成までを進める「ソフトウェアファクトリー」です。

現在は段階1(ワーカー)で、次のことができます。

- 対象リポジトリのイシューとコメントをポーリングで取り込み、SQLiteに記録する。
- `state:` ラベルのない新規イシューに `state:triage` を付ける(`dry_run: false` のときだけ)。
- 対象リポジトリの `factory.yml` を取得して検証する。
- ワーカーを、資格情報のない隔離されたコンテナで動かす。
- 人間が `state:ready` にしたイシューに着手し、計画、実装、検査、レビューを経て、プルリクエストを作る(`dry_run: false` のときだけ)。分類と着手の判断(司令塔)は、まだない。

設計は `docs/design.md`、段階0の仕様は `docs/stage0.md` にあります。

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

製品に固有のツールが要る場合は、`docker/worker.Dockerfile` を土台にした別のイメージを作り、`config/factory.config.yml` の `worker_image` で指定します。

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

設定を変えたときは、`docker compose restart office` で読み直します。

### GitHubへの書き込みを有効にする

`dry_run` を `false` にすると、`state:` ラベルのないオープンのイシューに `state:triage` が付きます。`true` の間は、付ける予定だったことをログに出すだけです(`github.write_skipped`)。

`dry_run` が `false` の間は、`state:ready` のイシューに着手します。`true` の間は、着手も、途中の実行を進めることもしません(ラベルを書けないと、GitHubから見えないところで作業が進むためです)。

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
| コミットの作者 | 設定の検証を通る作者の例(`scripts/commit-author-examples.ts`)それぞれについて、ワーカーのイメージのgitで作ったコミットの作者とコミッターが、設定の値と完全に一致する。一致しなければ、設定の値とコミットに書かれた値を出す |

環境を残して調べたいときは、`CHECK_KEEP=1 scripts/check-isolation.sh` で実行します。

## 状況表示

リポジトリごとに、状態別のイシュー数、未処理のイベント数、最後に同期した時刻を表示します。
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
