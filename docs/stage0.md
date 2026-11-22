# 段階0 実装指示書: 事務局の骨組み

このリポジトリは「ソフトウェアファクトリー」の本体です。GitHubのイシューを入力として、AIエージェントが実装からPR作成までを進める仕組みを、段階的に作ります。この文書は最初の段階(段階0)の実装指示です。

**今回は段階0だけを実装してください。** Claudeの呼び出し、ワーカー、ダッシュボードは後の段階で扱うので、作らないでください。不明点があれば、推測で進めずに質問してください。

## 1. 全体像(背景として)

| 役割 | 実体 | 担当 |
| --- | --- | --- |
| 事務局 | Nodeの常駐プロセス | 時計、永続化、キュー、再試行、GitHub同期、指示の検査 |
| 司令塔 | Claude(必要なときに呼ぶ) | 優先順位、着手の可否、人間に聞くかの判断 |
| ワーカー | Claude Code(ヘッドレス、隔離環境) | 計画、実装、レビュー。コミットまで |
| 対話エージェント | Claude Code(対話型) | 起票、質問と回答の取り次ぎ、報告 |

設計の原則:

- 事務局は判断しない。司令塔は実行しない。
- 人間に見える状態はGitHub(ラベル、イシュー、PR)に置き、実行の内部情報はSQLiteに置く。食い違ったらGitHubを信じる。
- GitHubへの書き込みは事務局だけが行う。
- ファクトリーが扱う対象リポジトリを「製品」と呼ぶ。**製品固有の知識(製品名、コマンド、パス)をファクトリーのコードに書かない。** 製品ごとの違いは、製品リポジトリ直下の `factory.yml` と、ファクトリー側の設定ファイルから読む。
- 1つのファクトリーが複数のリポジトリを扱える作りにする。

段階0で作るのは、このうち事務局の土台です。

## 2. 段階0の範囲

1. プロジェクトの初期化
2. ファクトリー側の設定の読み込みと検証
3. SQLiteのスキーマとマイグレーション
4. 状態遷移表
5. GitHubとの同期(ポーリングによる取り込み)
6. 製品の `factory.yml` の取得と検証
7. 常駐のメインループと状況表示コマンド
8. Docker Composeによる常駐
9. 自動テスト

### 範囲外(作らない)

- Claudeの呼び出し(司令塔、ワーカー)
- 実行(run)とステップの管理、worktree、PR作成
- 定期タスクの実行(テーブルだけ作る)
- ダッシュボード、HTTP API
- Webhook

## 3. 技術

- Node 22以上、TypeScript(strict)、ESM
- SQLite: better-sqlite3
- GitHub API: Octokit
- 入力の検証: zod
- YAML: yaml
- テスト: Vitest
- lintと整形: 任意の1つに決めてよい。`npm run lint` の1コマンドで実行できること

上記以外の依存を追加するときは、理由を説明してください。大きなフレームワークは入れないでください。

## 4. 構成

```text
factory/
  src/
    office/
      main.ts          起動とメインループ
      config.ts        ファクトリー側の設定
      db.ts            SQLiteとマイグレーション
      github.ts        GitHubクライアント(読み取りと書き込みをここに集約)
      sync.ts          同期の処理
      transitions.ts   遷移表
      product.ts       factory.yml の取得と検証
      status.ts        状況表示コマンド
      log.ts           構造化ログ
  migrations/
    001_init.sql
  config/
    factory.config.example.yml
  tests/
  Dockerfile
  docker-compose.yml
  .env.example
```

## 5. 仕様

### 5.1 ファクトリー側の設定

`config/factory.config.yml`(Git管理外。例を `factory.config.example.yml` として置く)。

```yaml
dry_run: true              # true の間、GitHubへ一切書き込まない
poll_interval_sec: 60
db_path: /data/factory.db
repos:
  - repo: owner/name       # 対象リポジトリ
    token_env: GITHUB_TOKEN_EXAMPLE   # トークンを入れた環境変数の名前
```

- zodで検証し、不正なら項目名の分かるメッセージで起動を中止する。
- トークンは環境変数からだけ読む。設定ファイル、ログ、DBに書かない。
- `dry_run` の既定値は `true`。

### 5.2 イシューの状態

イシューの状態は `state:` で始まるラベル1つで表す。

| ラベル | 意味 |
| --- | --- |
| `state:triage` | 新規、または再判定待ち |
| `state:needs-info` | 情報不足。人間の回答待ち |
| `state:blocked` | 依存先のイシューが未完了 |
| `state:ready` | 着手可能 |
| `state:in-progress` | ワーカーが作業中 |
| `state:in-review` | PR作成済み。人間のレビュー待ち |
| `state:failed` | 試行上限に達した。人間の判断待ち |

クローズされたイシューの状態は `closed`。補助ラベルは `priority:p0`〜`p3`、`size:s`/`m`/`l`、`agent:skip`。

### 5.3 遷移表

`transitions.ts` に、次の表をデータとして持たせる。関数は純粋関数にし、DBやGitHubに触れない。

| 遷移元 | 遷移先 | 実行者 |
| --- | --- | --- |
| (新規) | triage | 事務局 |
| triage | ready | 司令塔 |
| triage | needs-info | 司令塔 |
| triage | blocked | 司令塔 |
| needs-info | triage | 事務局 |
| blocked | triage | 事務局 |
| ready | in-progress | 事務局 |
| in-progress | in-review | 事務局 |
| in-progress | needs-info | 事務局 |
| in-progress | ready | 事務局 |
| in-progress | failed | 事務局 |
| in-review | in-progress | 事務局 |
| in-review | closed | 人間 |
| failed | triage | 事務局 |

- 「遷移元、遷移先、実行者」を渡すと、許可されているかを返す関数を用意する。
- 表にない遷移は拒否する。
- 人間がGitHub上でラベルを手で変えた場合は、この表による検査の対象外とし、そのまま受け入れる(GitHubが正)。

### 5.4 スキーマ

`migrations/001_init.sql` に次のテーブルを作る。段階0で読み書きするのは `repos`、`issues`、`events` だけだが、後の段階で使うテーブルも今回作っておく。

```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);

CREATE TABLE repos (
  repo                  TEXT PRIMARY KEY,   -- owner/name
  issues_synced_until   TEXT,
  comments_synced_until TEXT,
  factory_yml           TEXT,               -- 検証済みの内容(JSON)
  factory_yml_sha       TEXT,
  last_polled_at        TEXT
);

CREATE TABLE issues (
  repo              TEXT NOT NULL,
  number            INTEGER NOT NULL,
  title             TEXT NOT NULL,
  state             TEXT NOT NULL,
  priority          TEXT,
  size              TEXT,
  depends_on        TEXT,
  github_updated_at TEXT NOT NULL,
  synced_at         TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE TABLE events (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  repo         TEXT,
  issue_number INTEGER,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  handled_at   TEXT
);

CREATE TABLE decisions (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER REFERENCES events(id),
  repo          TEXT NOT NULL,
  command       TEXT NOT NULL,
  reason        TEXT NOT NULL,
  result        TEXT NOT NULL,
  reject_reason TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  repo          TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  attempt       INTEGER NOT NULL,
  status        TEXT NOT NULL,
  current_step  TEXT,
  worktree_path TEXT,
  branch        TEXT,
  pr_number     INTEGER,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  next_retry_at TEXT
);

CREATE TABLE steps (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL,
  output      TEXT,
  session_id  TEXT,
  cost_usd    REAL,
  log_path    TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE schedules (
  id             INTEGER PRIMARY KEY,
  repo           TEXT NOT NULL,
  name           TEXT NOT NULL,
  cron           TEXT NOT NULL,
  issue_template TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_fired_at  TEXT,
  UNIQUE (repo, name)
);

CREATE TABLE reports (
  id           INTEGER PRIMARY KEY,
  repo         TEXT,
  kind         TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
```

マイグレーション:

- `migrations/` の連番のSQLファイルを、未適用のものだけ順に適用する。
- 適用はトランザクションで行い、失敗したら元に戻す。
- 未適用のものがある場合は、適用前にDBファイルを複製する。
- 起動のたびに実行しても安全であること。
- 日時はすべてUTCのISO 8601形式の文字列で保存する。

### 5.5 GitHubとの同期

`github.ts` にクライアントのインターフェースを定義し、同期の処理(`sync.ts`)にはそれを注入する。テストでは偽のクライアントを使い、ネットワークに出ない。

1回のポーリングで、設定にある各リポジトリについて次を行う。

1. **イシューの取得。** 前回の取得位置より後に更新されたイシューを取得する(オープンとクローズの両方)。プルリクエストは除外する。
2. **状態の導出。** クローズ済みなら `closed`。オープンなら `state:` ラベルから決める。優先度と規模もラベルから読む。
3. **`issues` の更新とイベントの記録。**

   | 起きたこと | イベントの種類 |
   | --- | --- |
   | 初めて見るイシュー | `issue.created` |
   | 状態が変わった | `issue.state_changed`(変更前と変更後を含める) |
   | クローズされた | `issue.closed` |
   | `state:` ラベルが複数付いている | `issue.label_conflict`(状態は更新しない) |

4. **新規イシューへのラベル付け。** オープンで `state:` ラベルがないイシューには `state:triage` を付ける。`dry_run` が `true` のときは付けず、付ける予定だったことをログに出す。DB上の状態は `triage` として扱う。
5. **コメントの取得。** 前回の取得位置より後のイシューコメントを取得し、`issue.commented` を記録する。本文に `<!-- factory -->` を含むコメントはファクトリー自身のものなので、記録しない。
6. **取得位置の更新。** `repos` の取得位置を進める。

守ること:

- **重複させない。** 同じ変更を2回処理しても、イベントが二重に記録されないこと(再起動や、取得範囲の重なりに耐える)。
- **1つのリポジトリの失敗で全体を止めない。** エラーはログに出し、次のリポジトリへ進む。次回のポーリングで再試行する。
- **レート制限に従う。** 制限に達したら、解除時刻まで待つ。
- **書き込みは1か所。** GitHubへの書き込みは `github.ts` の関数だけが行い、すべて `dry_run` を確認する。

### 5.6 製品の `factory.yml`

各リポジトリの既定ブランチ直下にある `factory.yml` を取得し、zodで検証して `repos.factory_yml` にJSONで保存する。内容が変わっていなければ取得し直さない。

```yaml
version: 1
level: A                 # A / B / C
commands:
  setup: <コマンド>
  test: <コマンド>
  lint: <コマンド>
verify:
  unverified: [<文字列>, ...]
paths:
  protected: [<glob>, ...]
  forbidden: [<glob>, ...]
limits:
  max_parallel: 1
  max_attempts: 3
issues:
  allowed_authors: [<GitHubのログイン名>, ...]
```

- 未知のキーや不正な値があれば、そのリポジトリは「設定不正」として扱い、イベント `repo.config_invalid` を記録する。同期は続ける。
- ファイルがない場合は `repo.config_missing` を記録する。
- 段階0では、読み込んだ内容を使う処理は作らない(保存まで)。

### 5.7 メインループと状況表示

- 起動時にマイグレーションを実行し、設定を検証してから、`poll_interval_sec` ごとに同期する。
- SIGTERMとSIGINTを受けたら、実行中のポーリングを終えてから終了する。
- ログは1行1件のJSONで標準出力に出す。トークンを出力しない。
- 状況表示コマンド(`npm run status`)を用意する。リポジトリごとに、状態別のイシュー数、未処理のイベント数、最後に同期した時刻を表示する。

### 5.8 Docker Compose

- 事務局を1つのサービスとして動かす。`restart: unless-stopped` とし、EC2の再起動後に自動で復旧すること。
- DBファイルは名前付きボリュームに置く。
- トークンは `.env` から渡す。`.env` はGit管理外とし、`.env.example` を置く。

## 6. テスト

Vitestで、次を自動テストにする。ネットワークには出ない。

- **遷移表:** 表にある遷移はすべて許可される。表にない遷移は拒否される。実行者が違えば拒否される。
- **マイグレーション:** 空のDBに適用できる。2回実行しても変わらない。未適用があるときは複製が作られる。失敗したら元に戻る。
- **同期(偽のクライアントを使う):**
  - 新規イシューで、行とイベントができる。
  - ラベルが変わると、状態が更新され、変更前後を含むイベントができる。
  - クローズで、状態が `closed` になる。
  - プルリクエストは取り込まれない。
  - `state:` ラベルが複数あると、競合のイベントができ、状態は変わらない。
  - `<!-- factory -->` を含むコメントは記録されない。
  - 同じ内容を2回同期しても、イベントが増えない。
  - `dry_run` が `true` のとき、書き込みの関数が1回も呼ばれない。
  - 1つのリポジトリでエラーが起きても、他のリポジトリは同期される。
- **設定と `factory.yml` の検証:** 正常な例を読める。必須項目の欠落、未知のキー、不正な値で失敗する。

## 7. 受け入れ条件

- [ ] `npm ci`、`npm run typecheck`、`npm run lint`、`npm test` がすべて通る。
- [ ] `docker compose up -d` で起動し、ログにエラーが出ない。
- [ ] 対象リポジトリの既存のイシューが、最初のポーリングで `issues` に入る。
- [ ] 対象リポジトリにイシューを1件作ると、ポーリング2回以内に `issues` と `events` に入り、`npm run status` に反映される。
- [ ] コンテナを再起動しても、イベントが重複せず、続きから同期する。
- [ ] `dry_run: true` の間、GitHub上のラベルやコメントが一切変わらない。
- [ ] `dry_run: false` にすると、`state:` ラベルのない新規イシューに `state:triage` が付く。
- [ ] トークンが、リポジトリ、ログ、DBのどこにも含まれない。
- [ ] ファクトリーのコードとテストに、特定の製品の名前、コマンド、パスが含まれない(設定の例は仮の値を使う)。
- [ ] READMEに、セットアップ、起動、状況表示、テストの手順が書かれている。

## 8. 作業の進め方

- 最初に実装計画を示し、承認を得てから実装に入る。
- 遷移表とマイグレーションから始め、テストを先に書く。
- 小さな単位でコミットする。各コミットでテストが通ること。
- エラーを黙って握りつぶさない。想定外の入力は、分かるメッセージで失敗させる。
- この文書にない機能を足さない。必要だと考えた場合は、実装せずに提案する。
- 完了時に、受け入れ条件の各項目について、確認した方法と結果を報告する。
