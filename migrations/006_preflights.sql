-- 着手の前に、製品の commands.setup がワーカーのイメージで通ることを確かめた結果。
-- 製品ごとに1行で、最後に終わった確認だけを残す。実行できなかった確認(起動係に届かない、
-- 取得の失敗、中断)は、結果ではないので残さない。
CREATE TABLE preflights (
  repo            TEXT PRIMARY KEY,           -- owner/name
  status          TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  image           TEXT NOT NULL,              -- 確かめたときの、ワーカーのイメージの名前
  factory_yml_sha TEXT NOT NULL,              -- 確かめたときの factory.yml の sha
  command         TEXT NOT NULL,              -- 実行した commands.setup
  exit_code       INTEGER,                    -- 終了コード。シグナルで終わった場合は NULL
  timed_out       INTEGER NOT NULL DEFAULT 0, -- 時間の上限で止めたなら 1
  output_tail     TEXT NOT NULL DEFAULT '',   -- 通らなかった場合の、出力の末尾(トークンは伏せてある)
  log_path        TEXT NOT NULL,              -- 出力の全体を残したログの場所
  checked_at      TEXT NOT NULL               -- 確認が終わった時刻
);
