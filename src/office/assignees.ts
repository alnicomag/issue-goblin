/**
 * イシューの担当者(assignee)と、ファクトリーの担当の照合。
 *
 * 同じ製品を複数のファクトリーが見るときに、担当者にトークンの持ち主がいるイシューだけを、
 * そのファクトリーが扱う(設定の `assigned_only`)。ここにある関数は純粋関数で、
 * DBにもネットワークにも触れない。
 */
import { z } from "zod";

const AssigneesSchema = z.array(z.string());

/**
 * `issues.assignees`(ログイン名のJSON配列)を読む。未取得(NULL)なら null。
 * 配列として読めない値は、原因の分かるメッセージで失敗させる。
 */
export function parseAssignees(text: string | null): string[] | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`担当者の記録をJSONとして読めません: ${text}`, {
      cause: error,
    });
  }
  const result = AssigneesSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`担当者の記録が、ログイン名の配列ではありません: ${text}`);
  }
  return result.data;
}

/**
 * このファクトリーが扱ってよいイシューか。
 *
 * `owner` は、トークンの持ち主のログイン名。担当者で分けないリポジトリ(`assigned_only` が無効)では
 * null を渡し、その場合は、担当者によらず true を返す。
 * 担当者が分からない(null)イシューは、扱わない。GitHubのログイン名は、大文字と小文字を区別しない。
 */
export function isAssignedTo(
  assignees: readonly string[] | null,
  owner: string | null,
): boolean {
  if (owner === null) return true;
  if (assignees === null) return false;
  const lowered = owner.toLowerCase();
  return assignees.some((assignee) => assignee.toLowerCase() === lowered);
}

/**
 * ほかの人だけが担当しているイシューか(担当者がいて、その中に持ち主がいない)。
 * 担当者のいないイシューと、担当者で分けないリポジトリ(`owner` が null)では false。
 */
export function isAssignedToOthers(
  assignees: readonly string[],
  owner: string | null,
): boolean {
  return (
    owner !== null && assignees.length > 0 && !isAssignedTo(assignees, owner)
  );
}
