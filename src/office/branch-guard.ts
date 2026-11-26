/**
 * リモートに残っている作業用のブランチの確認。
 *
 * 担当者で着手を分けるリポジトリ(設定の `assigned_only`)では、同じ製品を複数のファクトリーが見る。
 * 担当が移ったイシューには、前の担当のファクトリーが push した作業用のブランチ(`agent/issue-<番号>`)が
 * リモートに残っていることがある。名前が同じなので、そのまま push すると、前の作業を上書きする。
 * ここでは、リモートのブランチが、このファクトリーのものかを見分ける。
 */
import type { Db } from "./db.ts";
import type { Git } from "./git.ts";
import { publishedHeads } from "./runs.ts";

/**
 * リモートの作業用のブランチの状態。
 *
 * - `absent`: リモートにブランチがない。
 * - `own`: リモートのブランチの先頭が、このファクトリーのものである。
 * - `foreign`: リモートのブランチの先頭が、このファクトリーの記録にない。別のファクトリーか、人間のもの。
 */
export type RemoteBranch =
  | { readonly kind: "absent" }
  | { readonly kind: "own"; readonly tip: string }
  | { readonly kind: "foreign"; readonly tip: string };

/**
 * リモートのブランチの先頭が、このファクトリーのものかを決める。純粋関数。
 *
 * このファクトリーのものとみなすのは、次のどちらかに一致する場合だけである。
 * - `publishedHeads`: このファクトリーが push した記録のあるコミット(`published` で終わった publish)。
 * - `mirrorHead`: ミラーにある、作業用のブランチの先頭(このファクトリーの作業場所から取り込んだもの)。
 *   push の後、記録の前に止まった場合に、自分の push を見分けるために見る。
 */
export function classifyRemoteBranch(input: {
  remoteTip: string | null;
  publishedHeads: ReadonlySet<string>;
  mirrorHead: string | null;
}): RemoteBranch {
  const { remoteTip } = input;
  if (remoteTip === null) return { kind: "absent" };
  return input.publishedHeads.has(remoteTip) || remoteTip === input.mirrorHead
    ? { kind: "own", tip: remoteTip }
    : { kind: "foreign", tip: remoteTip };
}

/** ミラーにある参照の先頭。なければ null。読むだけで、何も変えない。 */
async function refTip(
  git: Git,
  mirrorDir: string,
  ref: string,
): Promise<string | null> {
  const output = await git.run(
    ["for-each-ref", "--format=%(refname) %(objectname)", ref],
    { cwd: mirrorDir },
  );
  for (const line of output.split("\n")) {
    const [name, tip] = line.split(" ");
    if (name === ref && tip !== undefined && tip !== "") return tip;
  }
  return null;
}

/**
 * リモートの作業用のブランチの状態を調べる。読むだけで、何も変えない。
 *
 * ミラーは、先に `updateMirror` で最新にしておくこと。リモートのブランチは、
 * そのときに `refs/remotes/origin/*` に取得したものを読む。
 */
export async function checkRemoteBranch(
  deps: { db: Db; git: Git },
  input: { mirrorDir: string; repo: string; issue: number; branch: string },
): Promise<RemoteBranch> {
  const { mirrorDir, branch } = input;
  return classifyRemoteBranch({
    remoteTip: await refTip(
      deps.git,
      mirrorDir,
      `refs/remotes/origin/${branch}`,
    ),
    publishedHeads: publishedHeads(deps.db, input.repo, input.issue),
    mirrorHead: await refTip(deps.git, mirrorDir, `refs/heads/${branch}`),
  });
}

/** 残っていたブランチで止まったときの、要約。ログと、ステップの記録に残す。 */
export function foreignBranchSummary(branch: string, tip: string): string {
  return `リモートのブランチ ${branch} の先頭(${tip.slice(0, 12)})は、このファクトリーが push した記録にありません。上書きしないので、人間の対応待ちにします`;
}
