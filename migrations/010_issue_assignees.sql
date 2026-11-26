-- イシューの担当者(assignee)。担当者で、着手するファクトリーを分けるために使う。
-- GitHubの写しで、同期のたびにGitHubの内容で上書きする。

-- 担当者のログイン名のJSON配列(例: ["example-login"])。担当者がいなければ []。
-- この変更より前に取り込んだ行は、次の全件の取り直しまで NULL のまま。
-- NULL の間は、担当者を確かめられないので、担当で分ける設定のリポジトリでは着手しない。
ALTER TABLE issues ADD COLUMN assignees TEXT;
