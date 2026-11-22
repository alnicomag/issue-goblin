/**
 * ワーカーの出口になるプロキシ。
 *
 * HTTPSの `CONNECT` だけを受け付け、名前を引いた後のアドレスが外部のものであるときだけつなぐ。
 * つなぐ先は、判定したアドレスそのものにする(判定の後で名前を引き直さない)。
 * 通信の中身は見ない。
 */
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { errorFields, type Logger } from "../office/log.ts";
import {
  isInternalAddress,
  parseConnectTarget,
  pickExternalAddress,
} from "./policy.ts";

export const HTTPS_PORT = 443;

export interface ProxyOptions {
  /** 名前を引く。IPアドレスの文字列を返す。 */
  readonly lookup: (host: string) => Promise<readonly string[]>;
  readonly logger: Logger;
  /** 宛先につなぐ。テストで差し替えられる。 */
  readonly connect?: (address: string, port: number) => net.Socket;
  /** 通すポート。既定は443だけ。 */
  readonly allowedPorts?: readonly number[];
  /** 内部のアドレスかどうかの判定。既定は `isInternalAddress`。 */
  readonly isInternal?: (address: string) => boolean;
  /** 宛先につながるまで待つ時間。 */
  readonly connectTimeoutMs?: number;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
}

export function createProxyServer(options: ProxyOptions): http.Server {
  const {
    lookup,
    logger,
    connect = (address, port) => net.connect({ host: address, port }),
    allowedPorts = [HTTPS_PORT],
    isInternal = isInternalAddress,
    connectTimeoutMs = 15_000,
  } = options;

  // `CONNECT` 以外(平文のHTTP)は通さない。
  const server = http.createServer((request, response) => {
    logger.warn("proxy.refused", {
      reason: "not_connect",
      method: request.method,
    });
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("このプロキシは、HTTPSのCONNECTだけを通します\n");
  });

  server.on("connect", (request, client: Duplex, head: Buffer) => {
    client.on("error", () => {});
    void handleConnect(request.url ?? "", client, head);
  });

  async function handleConnect(
    rawTarget: string,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    const target = parseConnectTarget(rawTarget, allowedPorts);
    if (!target.ok) {
      logger.warn("proxy.refused", { reason: "bad_target", target: rawTarget });
      refuse(client, 403, target.reason);
      return;
    }

    let addresses: readonly string[];
    try {
      addresses = await lookup(target.host);
    } catch (error) {
      logger.warn("proxy.lookup_failed", {
        host: target.host,
        ...errorFields(error),
      });
      refuse(client, 502, "宛先の名前を引けません");
      return;
    }

    const address = pickExternalAddress(addresses, isInternal);
    if (address === undefined) {
      logger.warn("proxy.refused", {
        reason: "internal_destination",
        host: target.host,
      });
      refuse(client, 403, "内部の宛先には接続できません");
      return;
    }

    const upstream = connect(address, target.port);
    const timer = setTimeout(() => {
      upstream.destroy(new Error("接続がタイムアウトしました"));
    }, connectTimeoutMs);

    let established = false;
    upstream.once("connect", () => {
      clearTimeout(timer);
      established = true;
      logger.info("proxy.connected", { host: target.host, port: target.port });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", (error) => {
      clearTimeout(timer);
      logger.warn("proxy.connect_failed", {
        host: target.host,
        ...errorFields(error),
      });
      // つながった後の失敗は、中継を切るだけにする(応答はもう返してある)。
      if (established) {
        client.destroy();
      } else {
        refuse(client, 502, "宛先に接続できません");
      }
    });
    client.once("close", () => {
      clearTimeout(timer);
      upstream.destroy();
    });
    upstream.once("close", () => client.destroy());
  }

  return server;
}
