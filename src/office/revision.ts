/**
 * イメージの目印(作った元のコミット)。DBにもネットワークにも触れない。
 *
 * 目印は、ビルドのときに `scripts/revision.sh` の出力をビルド引数 `FACTORY_REVISION` で渡して付ける。
 * イメージのラベル(`factory.revision`)と、コンテナの環境変数(`FACTORY_REVISION`)に入る。
 * 目印を渡さずに作ったイメージ(これまでの作り方のもの)には、値がない。
 */
import { z } from "zod";

/** イメージに付ける、目印のラベルの名前。 */
export const REVISION_LABEL = "factory.revision";
/** コンテナの中から自分のイメージの目印を読むための、環境変数の名前。 */
export const REVISION_ENV = "FACTORY_REVISION";

/** コミット(40桁)と、未コミットの変更があったことを表す `-dirty`。それ以外の文字列は通さない。 */
const RevisionSchema = z.string().regex(/^[0-9a-f]{40}(-dirty)?$/);

/**
 * 目印として読めるものだけを返す。値がない場合と、目印の形でない場合は null(不明)。
 *
 * ラベルは、イメージを作った者が自由に書ける。形の合わないものを表示やログに出さないように、ここで落とす。
 */
export function parseRevision(raw: unknown): string | null {
  const result = RevisionSchema.safeParse(
    typeof raw === "string" ? raw.trim() : raw,
  );
  return result.success ? result.data : null;
}

/** 自分が動いているイメージの目印を、環境変数から読む。 */
export function revisionFromEnv(
  env: Record<string, string | undefined>,
): string | null {
  return parseRevision(env[REVISION_ENV]);
}

/** 表示用。短くしたコミットと、未コミットの変更の有無。不明なら「不明」。 */
export function formatRevision(revision: string | null): string {
  if (revision === null) return "不明";
  const dirty = revision.endsWith("-dirty");
  return `${revision.slice(0, 12)}${dirty ? "(未コミットの変更あり)" : ""}`;
}
