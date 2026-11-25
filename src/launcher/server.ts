/**
 * 起動係の窓口。Unixソケットの上で、HTTPの形で依頼を受ける。
 *
 * - `POST /run`: 依頼を1件実行し、終わったら結果を返す。
 * - `GET /health`: 動いていることを返す。
 *
 * ソケットは、事務局と起動係だけが共有するボリュームに置く。
 */
import http from "node:http";
import { errorFields, type Logger } from "../office/log.ts";
import type { Launcher } from "./launcher.ts";
import {
  MAX_ARGV_BYTES,
  MAX_DOCKERFILE_BYTES,
  MAX_STDIN_BYTES,
} from "./request.ts";

/** 依頼の本文の上限。標準入力、引数、Dockerfile の上限に、JSONにした分の余裕を足す。 */
export const MAX_BODY_BYTES =
  (MAX_STDIN_BYTES + MAX_ARGV_BYTES + MAX_DOCKERFILE_BYTES) * 2 + 64 * 1024;

function send(response: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

function readBody(request: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 捨てながら最後まで読む(途中で切ると、相手に応答が届かない)。
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export function createLauncherServer(deps: {
  launcher: Launcher;
  logger: Logger;
}): http.Server {
  const { launcher, logger } = deps;

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method === "GET" && request.url === "/health") {
      send(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || request.url !== "/run") {
      send(response, 404, { error: "POST /run だけを受け付けます" });
      return;
    }

    const body = await readBody(request);
    if (body === null) {
      send(response, 413, { error: "依頼が大きすぎます" });
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      send(response, 400, { error: "依頼をJSONとして読めません" });
      return;
    }

    // 依頼した側が結果を待たずにいなくなったら、コンテナを止める。
    const abandoned = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) abandoned.abort();
    });

    const outcome = await launcher.run(raw, abandoned.signal);
    if (abandoned.signal.aborted) return;
    if (outcome.ok) {
      send(response, 200, outcome.result);
    } else {
      send(response, 400, { error: outcome.error });
    }
  }

  return http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      logger.error("launcher.request_failed", errorFields(error));
      if (!response.headersSent) {
        send(response, 500, { error: "起動係の中で失敗しました" });
      } else {
        response.destroy();
      }
    });
  });
}
