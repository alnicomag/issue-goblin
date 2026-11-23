-- 着手の条件の検査と、ワーカーへの入力に使う、イシューの内容。
-- どれもGitHubの写しで、同期のたびにGitHubの内容で上書きする。

-- 起票者のログイン名。この変更より前に取り込んだ行は、次の全件の取り直しまで空のまま。
-- 空の間は、起票者を確かめられないので、着手しない。
ALTER TABLE issues ADD COLUMN author TEXT;

-- イシューの本文。
ALTER TABLE issues ADD COLUMN body TEXT;

-- `agent:skip` のラベルが付いているか(1 なら、エージェントは触らない)。
ALTER TABLE issues ADD COLUMN agent_skip INTEGER NOT NULL DEFAULT 0;
