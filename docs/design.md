# ソフトウェアファクトリー 設計たたき台

Nov 22, 2026 · @tatsuya

## 全体像

常駐プログラム(以下「事務局」)が時間と記録を管理し、判断はすべてClaudeに委ねます。Claudeは常駐させず、事務局がイベントのたびに起動します。

| 役割 | 実体 | 起動のきっかけ | 担当 | 触れてよいもの |
| --- | --- | --- | --- | --- |
| 事務局 | Nodeの常駐プロセス | 常時稼働 | 時計、永続化、キュー、再試行、プロセスの起動と監視、GitHub同期、指示の検査 | SQLite、GitHub API、ワーカーの起動 |
| 司令塔 | Claude(1回ごとの呼び出し) | イベントと定時 | 優先順位、着手の可否、人間に聞くかの判断、報告の要約 | 読み取りのみ。指示をJSONで返す |
| ワーカー | Claude Code(ヘッドレス) | 司令塔の指示 | 計画、実装、レビュー | 自分のworktree内のファイルとコミット |
| 対話エージェント | Claude Code(対話型、superpowers有効) | 人間が開く | 起票、質問と回答の取り次ぎ、報告 | イシューの作成とコメント |

設計の原則は3つです。

- 事務局は判断しない。司令塔は実行しない。
- 人間に見える状態はGitHubに、実行の内部情報はSQLiteに置く。
- mainへのマージは人間だけが行う。

## イシューの状態と遷移

イシューの状態は `state:` で始まるラベル1つで表し、人間の対応が必要なのは `needs-info`、`in-review`、`failed` の3つだけです。

&#91;embedded content: イシューの状態遷移 · 8状態\]

色の付いた3つが人間の対応待ちです。`failed` からは、人間が方針をコメントすると `triage` に戻ります(図では省略)。

| ラベル | 意味 | 次に動くのは |
| --- | --- | --- |
| `state:triage` | 新規、または再判定待ち | 司令塔 |
| `state:needs-info` | 情報不足。質問コメントつき | 人間 |
| `state:blocked` | 依存先のイシューが未完了 | 事務局(依存先のクローズを監視) |
| `state:ready` | 着手可能 | 司令塔(着手を指示) |
| `state:in-progress` | ワーカーが作業中 | ワーカー |
| `state:in-review` | PR作成済み | 人間(マージまたは修正依頼) |
| `state:failed` | 試行上限に達した | 人間(方針をコメント) |

完了はラベルではなく、イシューのクローズで表します。補助ラベルは `priority:p0`〜`p3`、`size:s`/`m`/`l`、`agent:skip`(エージェントは触らない)です。

### 遷移表

| 遷移元 | 遷移先 | 条件 | 実行者 |
| --- | --- | --- | --- |
| (新規) | triage | イシューが作成された | 事務局 |
| triage | ready | 受け入れ条件が明確で、依存がない | 司令塔 |
| triage | needs-info | 不明点がある | 司令塔(質問をコメント) |
| triage | blocked | 依存先が未完了 | 司令塔 |
| needs-info | triage | 人間がコメントで回答した | 事務局 |
| blocked | triage | 依存先がクローズされた | 事務局 |
| ready | in-progress | 司令塔が着手を指示し、同時実行の枠がある | 事務局 |
| in-progress | in-review | PRが作成され、テストとレビューを通過した | 事務局 |
| in-progress | needs-info | ワーカーが質問を返して終了した | 事務局 |
| in-progress | ready | 失敗したが試行回数に余裕がある(待機後に再試行) | 事務局 |
| in-progress | failed | 試行上限に達した | 事務局 |
| in-review | in-progress | 人間がPRに修正を依頼した | 事務局 |
| in-review | (クローズ) | 人間がマージした | GitHub |
| failed | triage | 人間が方針をコメントした | 事務局 |

事務局は、この表にない遷移を司令塔が指示しても実行しません。

## 司令塔の入出力

司令塔は状態の要約をJSONで受け取り、決まった種類の指示をJSONで返すだけの関数として扱います。

### 呼ばれるタイミング

- イシューの作成、または人間によるコメントや編集
- ワーカーの完了、質問、失敗
- 定時の見直し(例: 毎朝と、1時間ごと)
- 対話エージェント経由の割り込み(「これを最優先で」など)

短時間に続いたイベントは、30秒ほど待ってまとめて1回で渡します。

### 渡すもの

- きっかけとなったイベント
- 未クローズのイシュー一覧(番号、タイトル、状態、優先度、規模、依存、最終更新)
- きっかけのイシューの本文と直近のコメント
- 進行中の実行(イシュー、現在のステップ、経過時間、試行回数)
- 直近の失敗と、前回却下された指示
- 枠(同時実行の空き、当日の残り予算)

### 返せる指示

| 指示 | 引数 | 事務局の検査 |
| --- | --- | --- |
| `triage` | issue、state(ready / needs-info / blocked)、priority、size、depends\_on | 対象が triage である |
| `ask_human` | issue、question | 質問文が空でない |
| `start` | issue | ready である。枠と予算がある。依存がすべてクローズ済み |
| `reprioritize` | issue、priority | 対象が未クローズである |
| `cancel` | run | 実行中である |
| `report` | kind、body | なし(報告のキューに入る) |
| `noop` | なし | なし |

すべての指示に `reason` を必須とし、判断の記録に残します。検査に落ちた指示は実行せずに却下として記録し、次回の入力に含めます。

```json
{
  "commands": [
    { "type": "triage", "issue": 12, "state": "ready", "priority": "p1", "size": "s", "depends_on": [], "reason": "受け入れ条件が3点とも検証可能" },
    { "type": "ask_human", "issue": 8, "question": "CSVの文字コードはUTF-8でよいですか", "reason": "出力仕様が未指定" },
    { "type": "start", "issue": 12, "reason": "p1で依存なし、枠が1つ空いている" }
  ]
}
```

## ワーカーの実行手順

1回の実行は7つのステップを順に進み、ステップが終わるたびにチェックポイントを保存します。Claudeが担当するのは計画、実装、レビューの3つで、残りは事務局がコードで行います。

| ステップ | 実行者 | 内容 | チェックポイントに残すもの |
| --- | --- | --- | --- |
| 1. prepare | 事務局 | worktreeとブランチ `agent/issue-<番号>` を作る | worktreeのパス |
| 2. plan | Claude | イシューを読んで計画を書く。不明点があれば質問を返して終了する | 計画の本文 |
| 3. implement | Claude | 実装し、テストを書き、コミットする | コミットのハッシュ |
| 4. verify | 事務局 | テストとlintをコマンドで実行する | 終了コードとログ |
| 5. review | Claude(新しい文脈) | イシュー、差分、テスト結果だけを見て判定する | 判定と指摘 |
| 6. publish | 事務局 | pushしてPRを作り、`in-review` に進める | PR番号 |
| 7. cleanup | 事務局 | マージまたはクローズの後にworktreeを消す | なし |

- **差し戻し:** verify の失敗と review の修正要求は implement に戻します。1回の実行の中で2回までです。
- **再開:** 事務局が落ちたら、最後のチェックポイントの次のステップからやり直します。どのステップも、やり直して安全な作りにします(ブランチがあれば使う、PRがあれば更新する)。
- **上限:** Claudeの各ステップにターン数の上限とタイムアウトを設けます。
- **結果の形式:** Claudeのステップは `done` / `question` / `failed` のいずれかと要約をJSONで返します。事務局は、申告ではなくコミットやPRの実在を確かめてから状態を進めます。
- **定期タスク:** スケジュールがイシューを起票し、以降は通常のイシューと同じ経路を通ります。

## SQLiteスキーマ

テーブルは8つで、`issues` だけがGitHubの写し、残りは事務局だけが持つ実行の記録です。

```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);

-- repo は owner/name 形式。複数リポジトリを扱うため、1製品目から持たせる

-- GitHubイシューの写し(正はGitHub)
CREATE TABLE issues (
  repo              TEXT NOT NULL,
  number            INTEGER NOT NULL,
  title             TEXT NOT NULL,
  state             TEXT NOT NULL,   -- triage / needs-info / ... / closed
  priority          TEXT,
  size              TEXT,
  depends_on        TEXT,            -- JSON配列
  github_updated_at TEXT NOT NULL,
  synced_at         TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

-- 事務局が受け取ったイベントのキュー
CREATE TABLE events (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  repo         TEXT,
  issue_number INTEGER,
  payload      TEXT NOT NULL,        -- JSON
  created_at   TEXT NOT NULL,
  handled_at   TEXT
);

-- 司令塔の判断の記録
CREATE TABLE decisions (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER REFERENCES events(id),
  repo          TEXT NOT NULL,
  command       TEXT NOT NULL,       -- JSON
  reason        TEXT NOT NULL,
  result        TEXT NOT NULL,       -- applied / rejected
  reject_reason TEXT,
  created_at    TEXT NOT NULL
);

-- イシュー1件に対する1回の実行
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  repo          TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  attempt       INTEGER NOT NULL,
  status        TEXT NOT NULL,       -- running / done / question / failed / cancelled
  current_step  TEXT,
  worktree_path TEXT,
  branch        TEXT,
  pr_number     INTEGER,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  next_retry_at TEXT
);

-- ステップごとのチェックポイント
CREATE TABLE steps (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  name        TEXT NOT NULL,         -- prepare / plan / implement / ...
  status      TEXT NOT NULL,         -- running / done / failed
  output      TEXT,                  -- JSON
  session_id  TEXT,
  cost_usd    REAL,
  log_path    TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

-- 定期タスク
CREATE TABLE schedules (
  id             INTEGER PRIMARY KEY,
  repo           TEXT NOT NULL,
  name           TEXT NOT NULL,
  cron           TEXT NOT NULL,
  issue_template TEXT NOT NULL,      -- JSON
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_fired_at  TEXT,
  UNIQUE (repo, name)
);

-- 人間に伝える報告(repo が空なら全体の報告)
CREATE TABLE reports (
  id           INTEGER PRIMARY KEY,
  repo         TEXT,
  kind         TEXT NOT NULL,        -- daily / alert
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
```

段階0の具体化で、リポジトリごとの同期位置を持つテーブルを1つ追加しました。

```sql
-- リポジトリごとの同期状態
CREATE TABLE repos (
  repo                 TEXT PRIMARY KEY,   -- owner/name
  issues_synced_until  TEXT,               -- イシューの取得済み位置
  comments_synced_until TEXT,              -- コメントの取得済み位置
  factory_yml          TEXT,               -- 検証済みの内容(JSON)
  factory_yml_sha      TEXT,
  last_polled_at       TEXT
);
```

マイグレーションは連番のSQLファイルで管理し、適用前にDBファイルを複製します。

## GitHubとの同期

食い違ったときは常にGitHubを信じ、GitHubへの書き込みは事務局だけが行います。

- **取り込み:** 最初はポーリングで始めます(1分ごとに、更新されたイシューとPRを取得)。Webhookは公開エンドポイントが必要なので後回しにします。
- **書き出し:** ラベルの変更、コメント、push、PR作成はすべて事務局が行います。ワーカーはコミットまでで、GitHubのトークンを持ちません。
- **人間がラベルを手で変えた場合:** 事務局はそれに従います。実行中の作業があれば取り消します。
- **コメントの区別:** エージェントが書いたコメントには目印(`<!-- factory -->`)を付け、人間のコメントと見分けます。
- **認証:** 対象リポジトリだけに限定したトークンを使い、権限はイシュー、PR、コンテンツの読み書きに絞ります。mainはブランチ保護で直接pushを禁止します。

## ワーカーの封じ込め

ワーカーの範囲は「禁止する」のではなく「できない状態にする」ことで守ります。`gh` や `git push` を打てても、認証情報がなければ何も起きません。

| 層 | 内容 | 強さ |
| --- | --- | --- |
| 資格情報を渡さない | ワーカーの環境にGitHubのトークン、`gh` の認証ファイル、gitの資格情報ヘルパー、SSH鍵を置かない。HOMEを事務局と分ける | 主たる防御 |
| ネットワークを絞る | ワーカーからの外向き通信を、ClaudeのAPIとパッケージレジストリに限る。EC2のインスタンスメタデータにも届かせない | 強い |
| ツールの許可設定 | `gh`、`git push`、`curl` などを拒否リストに入れる | 補助(シェル経由で回避できる) |
| 事務局による検査 | pushの前に差分を調べ、保護対象のパスに触れていたら人間の承認待ちにする | 最後の網 |

注意点が2つあります。

- **worktreeは `.git` を共有する。** ワーカーは他ブランチの参照、gitの設定、`.git/hooks` を書き換えられます。固くするなら、イシューごとに別のcloneを使います。
- **事務局の `git` 実行時にフックを走らせない。** ワーカーが仕込んだフックが、トークンを持つ事務局の権限で動くのを防ぎます。事務局は自分専用のcloneにワーカーのコミットを取り込み、検査してからpushします。

## 対象リポジトリとの関係

対象リポジトリの設定はワーカーの振る舞いを変えるので、何を読み込むかを役割ごとに明示し、リポジトリ側にもファクトリー向けの取り決めを置きます。

### 設定の干渉

| リポジトリ内のもの | 起きうる干渉 | 方針 |
| --- | --- | --- |
| `CLAUDE.md`、`.claude/rules` | 「ユーザーに確認する」など対話前提の指示が、無人実行では推測や停止になる | ワーカーは読み込む。指示書で「確認が要る場面は質問を返して終了」と読み替えを明記する |
| スキル、プラグイン | 承認待ちを挟む手順が起動して止まる | ユーザー設定は読み込まない。プロジェクトのスキルは棚卸しして、無人で使えるものだけ残す |
| フック | 通知やフォーマッタがワーカー内でも走る。フック自体をワーカーが書き換えられる | 無人で害がないか確認する。`.claude/` の変更は保護対象にする |
| `settings.json` の権限 | リポジトリ側の許可がワーカーの権限を広げる | 事務局が渡す拒否設定を優先させる |
| `.mcp.json` | 外部サービスにつながるツールがワーカーに渡る | ワーカーでは無効にする |
| イシュー本文、コメント、リポジトリ内の文章 | 埋め込まれた指示に従ってしまう | データとして扱う。起票者の許可リストを設け、それ以外は自動で着手しない |

読み込む設定の範囲は、省略時の挙動に頼らず役割ごとに必ず明示します。司令塔は何も読み込まず、ワーカーはプロジェクト設定だけ、対話エージェントはユーザー設定も含めて読み込みます。

### リポジトリ側に必要な取り決め

- **ファクトリー向けの設定ファイル:** セットアップ、テスト、lintのコマンドと、変更禁止のパスを書きます(例: `factory.yml`)。どれも非対話で1コマンドで動くことが条件です。
- **検証できない範囲の明示:** DBなど外部サービスに依存するテストがワーカー環境で動かないなら、対象外と書き、PRに「未検証」と記載させます。
- **イシューテンプレート:** 受け入れ条件、範囲外、依存を書く欄を設けます。
- **ブランチとPR:** ブランチ名は `agent/issue-<番号>`。PRテンプレートに対応イシューと検証結果の欄を置きます。
- **ブランチ保護:** mainへの直接pushを禁止し、CIの成功と人間のレビューを必須にします。
- **保護対象のパス:** `.github/`、`.claude/`、`CLAUDE.md`、ファクトリー設定ファイルは、CODEOWNERSで人間のレビューを必須にします。
- **CIのシークレット:** シークレットを使うワークフローは、エージェントのPRでは走らせないか、承認制にします。
- **既存の自動化との重複:** イシューやコメントに反応する別のエージェント用ワークフローがあれば、どちらかに寄せます。

ルールの置き場所は次のように分けます。どのリポジトリにも共通する工程のルールはファクトリーの `prompts/` に、リポジトリ固有の事実(コマンド、禁止パス、規約)はリポジトリ側に置きます。

## 製品とファクトリーの境界

製品固有の知識はすべて製品のリポジトリに置き、ファクトリーのコードには製品名も製品固有のコマンドも書きません。製品の追加は、リポジトリに設定ファイルを置くだけで済むようにします。

| 層 | 製造業でいうと | 中身 | 置き場所 |
| --- | --- | --- | --- |
| 設備 | 汎用機、搬送、工程管理システム | 状態遷移、キュー、再試行、チェックポイント、封じ込め、報告 | ファクトリー |
| 治具と標準書 | 治具、作業標準書、検査基準 | ビルドとテストのコマンド、規約、禁止パス、レビュー基準 | 製品のリポジトリ |
| 個別指示 | 製造指示書 | 受け入れ条件、範囲、依存 | イシュー |

物理のラインと違い、作業者のClaudeは標準書を読めば製品に合わせて動けます。製品ごとの違いは文書で吸収し、設備が製品から受け取るのは、確実性が要る検査(コマンド)と安全(パス)だけにします。

### 製品側の契約

製品のリポジトリ直下に `factory.yml` を置きます。

```yaml
version: 1
level: A                 # 対応水準: A / B / C
commands:                # 非対話で動き、終了コードで合否が分かること
  setup: npm ci
  test: npm test
  lint: npm run lint
verify:
  unverified:            # ワーカー環境では確かめられない範囲
    - DBに接続する結合テスト
paths:
  protected:             # 変更に人間の承認が要る
    - .github/**
    - .claude/**
    - CLAUDE.md
    - factory.yml
  forbidden:             # ワーカーは変更しない
    - migrations/**
limits:
  max_parallel: 1
  max_attempts: 3
issues:
  allowed_authors:       # ここにない起票者のイシューは自動で着手しない
    - your-github-login
```

設定ファイルのほかに、製品は次の2点を満たします。

- イシューに受け入れ条件が書かれている。
- 規約が `CLAUDE.md` などに文書化されている。

契約を満たせない製品は、製品側を直すか、対応水準を下げます。ファクトリーを製品に合わせて改造することはしません。

### 対応水準

| 水準 | 製品の状態 | ファクトリーの関与 |
| --- | --- | --- |
| A | 自動テストが揃っている | 起票からPRまで自律で進める |
| B | テストが一部、または外部依存で動かない | PRは作るが「未検証」を明示し、人間の確認を厚くする |
| C | 自動検証の手段がない | 起票、整理、優先順位付け、報告まで。実装は人間 |

### 工程の違い

1製品目は既定の7ステップで固定します。2製品目で実際に食い違った箇所だけを設定に切り出します。切り出すときも、ステップの種類は3つ(Claudeに任せる、コマンドを実行する、人間の承認を待つ)に固定し、製品側が選べるのは並べ方と中身だけにします。

### 境界を守るための確認

- ファクトリーのコードと `prompts/` に、製品名や製品固有のコマンド、パスが出てこない。
- 製品を追加するとき、ファクトリーのコード変更が0行で済む。
- 1製品目から `issues`、`runs`、`schedules` の各テーブルにリポジトリの列を持たせる。
- 失敗は原因で2つに仕分ける。その製品だけで起きるなら製品側の治具や標準書を直し、どの製品でも起きるならファクトリーを直す。

## デプロイの単位

1つのファクトリーが複数のリポジトリを扱える作りにし、デプロイはリポジトリごとではなく信頼境界ごとに分けます。

| 部分 | 方針 | 理由 |
| --- | --- | --- |
| 管理(事務局、司令塔、対話エージェント、ダッシュボード) | リポジトリをまたいで共有する | 人間の注意と、マシンやAPIの枠を全体で配分できる |
| 実行(ワーカーの環境、clone、検査コマンド) | リポジトリごとに分離する | ある製品のワーカーが別の製品のコードに届かないようにする |

別のデプロイに分けるのは、次のいずれかに当てはまる場合です。同じコードを別の設定で立てます。

- 持ち主や契約が違う(仕事用と個人用、別の組織)。トークン、扱ってよいデータ、費用の負担先が異なる。
- ネットワークが違う(特定の環境からしか届かない依存がある)。
- ファクトリーの新版を、重要でない製品で先に試したい。

1製品目から守ることは3つです。

- 状態のテーブルにリポジトリの列を持たせる。
- リポジトリごとの設定(トークン、cloneの場所、上限)を、ファクトリー側の設定ファイルの一覧から読む。
- 司令塔への入力はリポジトリ単位で組み立てる。リポジトリ間の配分(同時実行数、予算、重み)は事務局のコードで行う。

## 技術構成

TypeScriptとNodeで1つのリポジトリにまとめ、EC2上でDocker Composeにより常駐させます。

| 用途 | 候補 |
| --- | --- |
| SQLite | better-sqlite3 |
| GitHub API | Octokit |
| Claudeの呼び出し | Claude Agent SDK(TypeScript)。合わなければ `claude -p` をサブプロセスで呼ぶ |
| 入出力の検査 | zod |
| スケジュール | cron式を扱える小さなライブラリ |
| APIとダッシュボード | ExpressとReact |
| テスト | Vitest |

```text
factory/
  src/
    office/            事務局
      main.ts          起動とメインループ
      db.ts            SQLiteとマイグレーション
      github.ts        同期と書き出し
      transitions.ts   遷移表と指示の検査
      scheduler.ts     定期タスク
      runner.ts        実行のステップ管理と再開
    agents/
      conductor.ts     司令塔の呼び出し
      worker.ts        plan / implement / review の呼び出し
      schemas.ts       入出力の型
    api/               ダッシュボード用の読み取りAPI
  prompts/             conductor.md, plan.md, implement.md, review.md
  migrations/          001_init.sql ...
  dashboard/           React
  tests/
  docker-compose.yml
```

- **プロセスの配置:** 事務局が1コンテナで、APIとダッシュボードの配信も兼ねます。ワーカーは事務局が起動し、別コンテナまたは別ユーザーで動かします。
- **隔離:** DBファイルとGitHubのトークンは、ワーカーから見えない場所に置きます。
- **指示書:** プロンプトはコードと分けて `prompts/` に置き、変更履歴を追えるようにします。
- **superpowers:** 司令塔とワーカーでは無効にし、対話エージェントだけで使います。

## ダッシュボード

最初は読み取り専用で作り、操作(停止、再開、手動の再試行)は後の段階で足します。

| 画面 | 見えるもの |
| --- | --- |
| 概況 | 状態ごとのイシュー数、進行中の実行、人間の対応待ち一覧、当日の費用 |
| イシュー | 一覧と、1件ごとの履歴(遷移、判断、実行) |
| 実行 | ステップの進み具合、ログ、費用、PRへのリンク |
| 判断ログ | 司令塔の指示と理由、却下された指示 |
| 定期タスク | 一覧、次回の実行時刻、有効・無効 |

外部には公開せず、最初はSSHのポート転送で開きます。実行中のエージェントをその場で眺めたいときは、herdrを併用します。

## 段階的な進め方

6段階に分け、段階2までは実験用リポジトリで進めてから実プロジェクトに向けます。

| 段階 | 範囲 | 確認方法 |
| --- | --- | --- |
| 0. 骨組み | DB、マイグレーション、GitHubのポーリング、遷移表、テスト | イシューを作るとDBに入る。遷移表の単体テストが通る |
| 1. ワーカー | 手動で `ready` にしたイシュー1件をPRにする | 小さなイシューでPRができる。途中で落として再起動しても続きから進む |
| 2. 司令塔 | 分類と着手指示の自動化 | 新規イシューが自動で分類され、不明点には質問コメントが付く |
| 3. ダッシュボード | 読み取り専用の画面 | 状態と判断ログを画面で追える |
| 4. 定期タスクと報告 | スケジュール、日次報告 | 定時にイシューが起票され、朝に報告が出る |
| 5. 対話エージェント | 対話での起票、質問への回答の取り次ぎ | 対話で起票でき、回答すると作業が再開する |

段階1を最初の山に置くのは、ヘッドレス実行の癖(権限、上限、静かな失敗)が早く分かるからです。段階5までは、このチャットや手動の起票で代用できます。

## 未決事項

- [ ] 対象リポジトリをどれにするか(実験用を新設するか)
- [ ] Claudeの呼び出し方(Agent SDKか `claude -p` か)と、認証方法、1日の予算上限
- [ ] 対話エージェントの窓口(EC2上のherdrで開くClaude Codeか、Slackなど別の経路か)
- [ ] ワーカーの隔離方法(別コンテナか別ユーザーか)
- [ ] 試行上限と待機時間(仮: 3回、5分・30分・2時間)
- [ ] 同時実行数の上限(仮: 1件から始める)
- [ ] issue-goblinから引き継ぐもの(Composeによる自動復旧の設定など)
