/**
 * 事務局が起動係に依頼するための口。
 *
 * ワーカーの呼び出しや検査コマンドの実行は、このインターフェース越しに行う。
 * テストでは、偽の実装に差し替える。
 */
import http from "node:http";
import { z } from "zod";
import {
  type RunRequestInput,
  type RunResult,
  RunResultSchema,
} from "./request.ts";

export interface WorkerLauncher {
  /**
   * ワーカーのコンテナでコマンドを実行し、終わるまで待つ。
   * コマンドが失敗しても、結果(終了コード)として返る。
   * 依頼が拒否された場合や、起動係に届かない場合は、例外になる。
   */
  run(request: RunRequestInput): Promise<RunResult>;
}

const ErrorBodySchema = z.object({ error: z.string() });

/** 起動係の時間の上限に足す、応答を待つ余裕。 */
const RESPONSE_MARGIN_MS = 60_000;

export function createLauncherClient(options: {
  /** 起動係のUnixソケットの場所。 */
  socketPath: string;
}): WorkerLauncher {
  return {
    run(request) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(request);
        const call = http.request(
          {
            socketPath: options.socketPath,
            path: "/run",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let raw: unknown;
              try {
                raw = JSON.parse(text);
              } catch {
                reject(new Error("起動係の応答をJSONとして読めません"));
                return;
              }
              if (response.statusCode !== 200) {
                const failure = ErrorBodySchema.safeParse(raw);
                reject(
                  new Error(
                    failure.success
                      ? `起動係が依頼を拒否しました: ${failure.data.error}`
                      : `起動係が失敗しました(状態 ${response.statusCode})`,
                  ),
                );
                return;
              }
              const result = RunResultSchema.safeParse(raw);
              if (!result.success) {
                reject(new Error("起動係の応答の形式が不正です"));
                return;
              }
              resolve(result.data);
            });
          },
        );
        call.setTimeout(request.timeout_sec * 1000 + RESPONSE_MARGIN_MS, () => {
          call.destroy(new Error("起動係の応答がありません"));
        });
        call.on("error", (error) => {
          reject(
            new Error(`起動係に届きません: ${options.socketPath}`, {
              cause: error,
            }),
          );
        });
        call.end(body);
      });
    },
  };
}
