import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/office/log.ts";
import {
  isInternalAddress,
  parseConnectTarget,
  pickExternalAddress,
} from "../src/proxy/policy.ts";
import { createProxyServer, type ProxyOptions } from "../src/proxy/server.ts";

describe("プロキシの判定", () => {
  it("内部のアドレスを見分ける", () => {
    const internal = [
      "169.254.169.254", // インスタンスメタデータ
      "169.254.170.2",
      "127.0.0.1",
      "10.0.0.5",
      "172.17.0.1", // Dockerのブリッジ
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fd00:ec2::254", // IPv6のインスタンスメタデータ
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe", // 同じアドレスの16進表記
      "64:ff9b::a9fe:a9fe",
    ];
    for (const address of internal) {
      expect(isInternalAddress(address), address).toBe(true);
    }
  });

  it("外部のアドレスは通す", () => {
    for (const address of [
      "1.1.1.1",
      "93.184.216.34",
      "172.32.0.1",
      "169.253.0.1",
      "2606:4700:4700::1111",
      "::ffff:1.1.1.1",
    ]) {
      expect(isInternalAddress(address), address).toBe(false);
    }
  });

  it("IPアドレスとして読めないものは、内部として扱う", () => {
    for (const address of [
      "",
      "example.test",
      "1.2.3",
      "1.2.3.4.5",
      "0x7f.1",
    ]) {
      expect(isInternalAddress(address), address).toBe(true);
    }
  });

  it("引いたアドレスから、最初の外部のものを選ぶ", () => {
    expect(pickExternalAddress(["10.0.0.1", "1.1.1.1", "8.8.8.8"])).toBe(
      "1.1.1.1",
    );
    expect(
      pickExternalAddress(["10.0.0.1", "169.254.169.254"]),
    ).toBeUndefined();
    expect(pickExternalAddress([])).toBeUndefined();
  });

  it("CONNECTの宛先を読む", () => {
    expect(parseConnectTarget("example.test:443", [443])).toEqual({
      ok: true,
      host: "example.test",
      port: 443,
    });
    expect(parseConnectTarget("[2606:4700::1111]:443", [443])).toEqual({
      ok: true,
      host: "2606:4700::1111",
      port: 443,
    });
  });

  it("443番以外のポートと、読めない宛先は通さない", () => {
    for (const target of [
      "example.test:80",
      "example.test:22",
      "example.test",
      "example.test:",
      ":443",
      "http://example.test:443",
      "example.test:443/path",
      "user@example.test:443",
      "example.test:443 ",
      "",
    ]) {
      expect(parseConnectTarget(target, [443]).ok, target).toBe(false);
    }
  });
});

describe("プロキシ", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  function listen(server: net.Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        closers.push(
          () =>
            new Promise((done) => {
              if (server instanceof http.Server) server.closeAllConnections();
              server.close(() => done());
            }),
        );
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  async function startProxy(
    options: Omit<ProxyOptions, "logger">,
  ): Promise<number> {
    return listen(createProxyServer({ logger: silentLogger, ...options }));
  }

  /** 受け取ったものをそのまま返す、仮の宛先。 */
  async function startEcho(): Promise<number> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.pipe(socket);
    });
    const port = await listen(server);
    closers.unshift(async () => {
      for (const socket of sockets) socket.destroy();
    });
    return port;
  }

  function connectThrough(
    proxyPort: number,
    target: string,
  ): Promise<{ status: number; socket: net.Socket; body: string }> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: target,
      });
      request.on("connect", (response, socket) => {
        resolve({ status: response.statusCode ?? 0, socket, body: "" });
      });
      request.on("response", (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            socket: response.socket,
            body,
          }),
        );
      });
      request.on("error", reject);
      request.end();
    });
  }

  it("外部の宛先には、判定したアドレスでつなぎ、双方向に中継する", async () => {
    const echoPort = await startEcho();
    const connected: Array<[string, number]> = [];
    const proxyPort = await startProxy({
      lookup: async () => ["203.0.113.10"],
      allowedPorts: [echoPort],
      // 仮の外部アドレスへの接続を、手元の宛先に向ける。
      connect: (address, port) => {
        connected.push([address, port]);
        return net.connect({ host: "127.0.0.1", port });
      },
    });

    const { status, socket } = await connectThrough(
      proxyPort,
      `example.test:${echoPort}`,
    );
    expect(status).toBe(200);
    const reply = new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    });
    socket.write("hello");
    expect(await reply).toBe("hello");
    socket.destroy();
    expect(connected).toEqual([["203.0.113.10", echoPort]]);
  });

  it("内部のアドレスを指す名前には、つなぎにいかずに拒否する", async () => {
    for (const address of ["169.254.169.254", "127.0.0.1", "172.17.0.1"]) {
      let attempts = 0;
      const proxyPort = await startProxy({
        lookup: async () => [address],
        connect: () => {
          attempts += 1;
          return net.connect({ host: "127.0.0.1", port: 9 });
        },
      });
      const { status } = await connectThrough(proxyPort, "metadata.test:443");
      expect(status, address).toBe(403);
      expect(attempts, address).toBe(0);
    }
  });

  it("IPアドレスを直接指定されても、内部なら拒否する", async () => {
    const proxyPort = await startProxy({
      // 実際の名前解決と同じく、IPアドレスはそのまま返る。
      lookup: async (host) => [host],
    });
    expect(
      (await connectThrough(proxyPort, "169.254.169.254:443")).status,
    ).toBe(403);
    expect(
      (await connectThrough(proxyPort, "[fd00:ec2::254]:443")).status,
    ).toBe(403);
  });

  it("443番以外のポートは拒否する", async () => {
    let lookups = 0;
    const proxyPort = await startProxy({
      lookup: async () => {
        lookups += 1;
        return ["203.0.113.10"];
      },
    });
    expect((await connectThrough(proxyPort, "example.test:80")).status).toBe(
      403,
    );
    expect(lookups).toBe(0);
  });

  it("名前を引けなければ502を返す", async () => {
    const proxyPort = await startProxy({
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect((await connectThrough(proxyPort, "missing.test:443")).status).toBe(
      502,
    );
  });

  it("宛先につながらなければ502を返す", async () => {
    // 待ち受けを閉じた後のポートを、つながらない宛先として使う。
    const closed = net.createServer();
    const closedPort = await new Promise<number>((resolve) => {
      closed.listen(0, "127.0.0.1", () => {
        const { port } = closed.address() as AddressInfo;
        closed.close(() => resolve(port));
      });
    });
    const proxyPort = await startProxy({
      lookup: async () => ["203.0.113.10"],
      connect: () => net.connect({ host: "127.0.0.1", port: closedPort }),
    });
    expect((await connectThrough(proxyPort, "example.test:443")).status).toBe(
      502,
    );
  });

  it("CONNECT以外の要求(平文のHTTP)は拒否する", async () => {
    const proxyPort = await startProxy({
      lookup: async () => ["203.0.113.10"],
    });
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: proxyPort,
            path: "http://example.test/",
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        )
        .on("error", reject);
    });
    expect(status).toBe(403);
  });
});
