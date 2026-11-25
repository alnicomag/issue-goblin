-- PRへの修正依頼(レビューの「変更を要求」)を取り込み、実装をやり直すための変更。

-- 取り込んだ修正依頼。レビュー1件につき1行で、受け付けない人の分も残す。
-- 受け付けるかは、取り込んだ時点の issues.allowed_authors で決めて、accepted に残す。
-- 受け付けた依頼は、クローズ待ちの実行を implement からやり直すときに、使用済みにする。
CREATE TABLE change_requests (
  id           INTEGER PRIMARY KEY,
  repo         TEXT NOT NULL,              -- owner/name
  issue_number INTEGER NOT NULL,           -- PRを作った実行のイシュー
  pr_number    INTEGER NOT NULL,
  review_id    INTEGER NOT NULL,           -- GitHubのレビューのID
  author       TEXT,                       -- レビューした人のログイン名
  accepted     INTEGER NOT NULL,           -- 1 なら、受け付ける人の依頼
  body         TEXT NOT NULL,              -- レビューの本文
  comments     TEXT NOT NULL,              -- レビューの行コメント(JSON配列)
  commit_id    TEXT,                       -- レビューの対象のコミット
  submitted_at TEXT NOT NULL,              -- レビューが出された時刻
  created_at   TEXT NOT NULL,              -- 取り込んだ時刻
  run_id       INTEGER REFERENCES runs(id),   -- やり直した実行。未使用なら NULL
  step_id      INTEGER REFERENCES steps(id),  -- やり直しの最初の implement のステップ
  used_at      TEXT,                       -- やり直しを始めた時刻。未使用なら NULL
  UNIQUE (repo, review_id)
);
