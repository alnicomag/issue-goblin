-- 中断したワーカーの呼び出しのログを、再開したステップから辿れるようにする。

-- 事務局の停止で中断した呼び出しの、ログの場所(パスのJSON配列)。中断がなければ NULL。
-- 再開は同じ行を使うので、log_path(最後まで終わった呼び出し)と並べて残る。
ALTER TABLE steps ADD COLUMN interrupted_log_paths TEXT;
