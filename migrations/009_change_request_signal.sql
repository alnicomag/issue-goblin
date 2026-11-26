-- PRの作成者本人が出せる修正依頼の合図(PRのラベル agent:rework)のための変更。

-- 依頼を取り込んだ合図。
--   review: レビューの「変更を要求」
--   label:  PRのラベル agent:rework が付いているときに読んだ、コメントだけのレビュー
-- label の依頼でやり直しを始めるときに、事務局はラベルを外す。
ALTER TABLE change_requests ADD COLUMN signal TEXT NOT NULL DEFAULT 'review'
  CHECK (signal IN ('review', 'label'));
