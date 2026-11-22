-- 実行とステップの記録のための変更。

-- 実行とステップの記録が重複しないように、DBの側でも守る。
-- 1つのイシューに対して、実行中の実行は1つだけ
CREATE UNIQUE INDEX runs_one_running_per_issue
  ON runs (repo, issue_number) WHERE status = 'running';

-- 1つの実行の中で、実行中のステップは1つだけ
CREATE UNIQUE INDEX steps_one_running_per_run
  ON steps (run_id) WHERE status = 'running';

-- 試行回数をリセットした時刻。値のある失敗は、試行に数えない。
-- 人間が failed のイシューを戻したときに、それまでの失敗に入れる。
ALTER TABLE runs ADD COLUMN attempt_reset_at TEXT;
