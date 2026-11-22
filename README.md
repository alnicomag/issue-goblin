# issue-goblin

GitHubのイシューを入力として、AIエージェントが実装からプルリクエストの作成までを進める「ソフトウェアファクトリー」です。

現在は段階0(事務局の骨組み)で、次のことができます。

- 対象リポジトリのイシューとコメントをポーリングで取り込み、SQLiteに記録する。
- `state:` ラベルのない新規イシューに `state:triage` を付ける(`dry_run: false` のときだけ)。
- 対象リポジトリの `factory.yml` を取得して検証する。

設計は `docs/design.md`、段階0の仕様は `docs/stage0.md` にあります。

## 必要なもの

- Node 22.18 以上(TypeScriptをビルドせずに直接実行します)
- pnpm(`corepack enable pnpm` で使えます)
- Docker と Docker Compose(常駐させる場合)

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
| Contents | 読み取り | 読み取り |

`config/factory.config.yml` と `.env` はGit管理外です。

## 起動

```bash
docker compose up -d --build
docker compose logs -f office
```

- 起動時にマイグレーションを実行します。未適用のものがあれば、適用前にDBファイルを同じ場所に複製します(`factory.db.bak-v<版>-<日時>`)。
- DBファイルは名前付きボリューム `factory-data` に置かれます。
- `restart: unless-stopped` なので、ホストの再起動後も自動で復旧します。Dockerが起動時に立ち上がるようにしておいてください(`sudo systemctl enable docker`)。
- 停止は `docker compose stop` です。実行中のポーリングを終えてから終了します。
- ログは1行1件のJSONです。

設定を変えたときは、`docker compose restart office` で読み直します。

### GitHubへの書き込みを有効にする

`dry_run` を `false` にすると、`state:` ラベルのないオープンのイシューに `state:triage` が付きます。`true` の間は、付ける予定だったことをログに出すだけです(`github.write_skipped`)。

## 状況表示

リポジトリごとに、状態別のイシュー数、未処理のイベント数、最後に同期した時刻を表示します。

```bash
docker compose exec office node src/office/status.ts
```

Dockerを使わずに動かしている場合は、次のコマンドです。

```bash
pnpm run status
```

## Dockerを使わずに動かす

`db_path` を手元のパス(例: `./data/factory.db`)にして、トークンを環境変数に入れて起動します。

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
| `migrations/` | 連番のSQLファイル |
| `config/` | ファクトリー側の設定の例 |
| `tests/` | 自動テスト |
| `.claude/skills/` | 開発で使うスキル(`/issue`) |
| `.github/` | イシューとPRのテンプレート |
