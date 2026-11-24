-- 製品の Dockerfile(factory.yml の worker.dockerfile が指すファイル)。
-- 事務局が、既定ブランチから取得して保存する。ワーカーのイメージのビルドには、この本文だけを使う。
-- 作業場所のファイルは、ワーカーが書き換えられるので使わない。
ALTER TABLE repos ADD COLUMN worker_dockerfile TEXT;       -- 本文。取得できていなければ NULL
ALTER TABLE repos ADD COLUMN worker_dockerfile_sha TEXT;   -- 取得した内容の sha
ALTER TABLE repos ADD COLUMN worker_dockerfile_path TEXT;  -- 取得したときの worker.dockerfile

-- 着手前の確認の条件に、製品の Dockerfile の sha を足す。Dockerfile のない製品では NULL。
ALTER TABLE preflights ADD COLUMN dockerfile_sha TEXT;
