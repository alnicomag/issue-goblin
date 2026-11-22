-- 段階0の初期スキーマ。
-- schema_version は db.ts が管理するので、ここでは作らない。
-- 日時はすべてUTCのISO 8601形式の文字列で保存する。

-- リポジトリごとの同期状態
CREATE TABLE repos (
  repo                  TEXT PRIMARY KEY,   -- owner/name
  issues_synced_until   TEXT,               -- イシューの取得済み位置
  comments_synced_until TEXT,               -- コメントの取得済み位置
  factory_yml           TEXT,               -- 検証済みの内容(JSON)
  factory_yml_sha       TEXT,
  last_polled_at        TEXT
);

-- GitHubイシューの写し(正はGitHub)
CREATE TABLE issues (
  repo              TEXT NOT NULL,
  number            INTEGER NOT NULL,
  title             TEXT NOT NULL,
  state             TEXT NOT NULL,          -- triage / needs-info / ... / closed
  priority          TEXT,
  size              TEXT,
  depends_on        TEXT,                   -- JSON配列
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
  payload      TEXT NOT NULL,               -- JSON
  created_at   TEXT NOT NULL,
  handled_at   TEXT
);

-- 司令塔の判断の記録
CREATE TABLE decisions (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER REFERENCES events(id),
  repo          TEXT NOT NULL,
  command       TEXT NOT NULL,              -- JSON
  reason        TEXT NOT NULL,
  result        TEXT NOT NULL,              -- applied / rejected
  reject_reason TEXT,
  created_at    TEXT NOT NULL
);

-- イシュー1件に対する1回の実行
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  repo          TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  attempt       INTEGER NOT NULL,
  status        TEXT NOT NULL,              -- running / done / question / failed / cancelled
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
  name        TEXT NOT NULL,                -- prepare / plan / implement / ...
  status      TEXT NOT NULL,                -- running / done / failed
  output      TEXT,                         -- JSON
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
  issue_template TEXT NOT NULL,             -- JSON
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_fired_at  TEXT,
  UNIQUE (repo, name)
);

-- 人間に伝える報告(repo が空なら全体の報告)
CREATE TABLE reports (
  id           INTEGER PRIMARY KEY,
  repo         TEXT,
  kind         TEXT NOT NULL,               -- daily / alert
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
