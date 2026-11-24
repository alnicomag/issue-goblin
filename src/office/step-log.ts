/**
 * ステップのログの書き出し。ワーカーの呼び出しと、検査コマンドの実行で共用する。
 *
 * 置き場所は `<logs_dir>/<owner>/<name>/issue-<番号>/<開始時刻>-<ステップ>.log`。
 * 着手前の確認のログは、`<logs_dir>/<owner>/<name>/preflight/<開始時刻>-preflight.log`。
 * ワーカーが書き換えられないように、作業場所の外(事務局のデータの置き場所)に置く。
 */
import fs from "node:fs";
import path from "node:path";
import { issueDirFor, preflightDirFor } from "../launcher/container.ts";

/**
 * Claudeのトークンに見える文字列を伏せる。
 *
 * 事務局はトークンの値を持たないので、値の照合ではなく、書き方(`sk-ant-` で始まる)で見つける。
 * ワーカーは自分のトークンを出力や作業場所に書けるので、ログや記録に残す前に必ず通す。
 */
export function maskSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
}

/** そのイシューのログを置くディレクトリ。`repo` は設定にある書き方で渡す。 */
export function stepLogDir(
  logsDir: string,
  repo: string,
  issue: number,
): string {
  return path.join(logsDir, issueDirFor(repo, issue));
}

/** 着手前の確認のログを置くディレクトリ。`repo` は設定にある書き方で渡す。 */
export function preflightLogDir(logsDir: string, repo: string): string {
  return path.join(logsDir, preflightDirFor(repo));
}

/** ログのファイル名に使う時刻(例: 20260102T030405.678Z)。 */
function fileStamp(time: Date): string {
  return time.toISOString().replace(/[-:]/g, "");
}

/**
 * ログを新しいファイルに書き、その場所を返す。同じ名前があれば、番号を付ける。
 * トークンに見える文字列は、伏せてから書く。
 */
export function writeStepLog(input: {
  dir: string;
  startedAt: Date;
  step: string;
  text: string;
}): string {
  const name = `${fileStamp(input.startedAt)}-${input.step}`;
  const text = maskSecrets(input.text);
  fs.mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const file = path.join(input.dir, `${name}${suffix}.log`);
    try {
      fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`ステップのログを書けません: ${file}`, {
          cause: error,
        });
      }
    }
  }
  throw new Error(
    `ステップのログの名前が重なりすぎています: ${input.dir}/${name}`,
  );
}
