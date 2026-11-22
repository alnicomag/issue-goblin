/**
 * プロキシの起動。
 *
 * ワーカーのネットワーク(外への経路がない)と、外に出られるネットワークの両方につながる
 * コンテナで動かす。資格情報は持たない。
 */
import dns from "node:dns/promises";
import { createLogger, errorFields } from "../office/log.ts";
import { createProxyServer } from "./server.ts";

export const DEFAULT_PROXY_PORT = 3128;

function main(): void {
  const logger = createLogger();
  const port = Number(process.env.PROXY_PORT ?? DEFAULT_PROXY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PROXY_PORT が不正です: ${process.env.PROXY_PORT}`);
  }

  const server = createProxyServer({
    logger,
    lookup: async (host) => {
      const results = await dns.lookup(host, { all: true, verbatim: true });
      return results.map((result) => result.address);
    },
  });
  server.listen(port, () => logger.info("proxy.started", { port }));

  for (const name of ["SIGTERM", "SIGINT"] as const) {
    process.on(name, () => {
      logger.info("proxy.stopping", { signal: name });
      server.close();
      server.closeAllConnections();
    });
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    createLogger().error("proxy.fatal", errorFields(error));
    process.exitCode = 1;
  }
}
