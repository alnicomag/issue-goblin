/**
 * 設定の検証を通る、コミットの作者の例。gitが、そのままコミットに書くもの。
 *
 * 自動テスト(`tests/`)と、ワーカーのイメージのgitでの確認(`scripts/author-check.ts`)の
 * 両方が、ここから読む。確認は事務局のコンテナの中で動くので、イメージに入る `scripts/` に置く。
 */
export const ACCEPTED_COMMIT_AUTHORS: readonly {
  readonly name: string;
  readonly email: string;
}[] = [
  { name: "factory-worker", email: "factory-worker@example.invalid" },
  { name: "Example Bot", email: "bot@example.invalid" },
  // 途中にある記号は、gitが落とさない。
  { name: "Example, Inc. Bot", email: "example.bot+factory@example.invalid" },
  { name: 'O\'Brien: the "Bot"; v1.2', email: "o'brien@example.invalid" },
  { name: "back\\slash  two-spaces", email: "a_b-c@sub.example.invalid" },
  { name: "日本語の ボット", email: "bot@example.invalid" },
  { name: "Bot (factory) #1!", email: "bot#1@example.invalid" },
  { name: "x", email: "x@example.invalid" },
];
