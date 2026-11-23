-- 保護対象のパスに触れた変更を、人間の承認でPRにするための変更。

-- `agent:approved` のラベルが付いているか(1 なら、付いている)。GitHubの写し。
-- 承認として扱うかは、止まった実行の記録と合わせて決める。
ALTER TABLE issues ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;

-- 人間の承認の記録。publish が needs_approval で止まったステップ1つにつき、1件まで。
-- 承認が効くのは、そのステップが止まったときのコミット(head_commit)だけ。
CREATE TABLE approvals (
  id           INTEGER PRIMARY KEY,
  repo         TEXT NOT NULL,              -- owner/name
  issue_number INTEGER NOT NULL,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  step_id      INTEGER NOT NULL UNIQUE REFERENCES steps(id),  -- 止まった publish のステップ
  head_commit  TEXT NOT NULL,              -- 承認されたコミット
  created_at   TEXT NOT NULL,              -- 承認を受け取った時刻
  used_at      TEXT                        -- 実行を publish から再開した時刻。未使用なら NULL
);
