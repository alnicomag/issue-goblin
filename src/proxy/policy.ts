/**
 * プロキシの判定。DBにもネットワークにも触れない。
 *
 * ワーカーからの外向き通信は、ここで通すと決めたものだけが外に出る。
 * 判定は、名前ではなく、名前を引いた後のIPアドレスで行う。
 * 内部のアドレスを指す名前を用意されても、通さないためである。
 */
import net from "node:net";

/** 通さない宛先。ホスト、ほかのコンテナ、インスタンスメタデータを含む範囲。 */
const INTERNAL_SUBNETS: ReadonlyArray<
  readonly [string, number, "ipv4" | "ipv6"]
> = [
  ["0.0.0.0", 8, "ipv4"], // 「このホスト」
  ["10.0.0.0", 8, "ipv4"], // プライベート
  ["100.64.0.0", 10, "ipv4"], // キャリアグレードNAT
  ["127.0.0.0", 8, "ipv4"], // ループバック
  ["169.254.0.0", 16, "ipv4"], // リンクローカル(インスタンスメタデータ)
  ["172.16.0.0", 12, "ipv4"], // プライベート(Dockerのネットワーク)
  ["192.0.0.0", 24, "ipv4"], // プロトコル用の予約
  ["192.168.0.0", 16, "ipv4"], // プライベート
  ["198.18.0.0", 15, "ipv4"], // ベンチマーク用
  ["224.0.0.0", 4, "ipv4"], // マルチキャスト
  ["240.0.0.0", 4, "ipv4"], // 予約とブロードキャスト
  ["::", 127, "ipv6"], // 未指定とループバック
  ["64:ff9b::", 96, "ipv6"], // NAT64
  ["fc00::", 7, "ipv6"], // ユニークローカル(IPv6のインスタンスメタデータ)
  ["fe80::", 10, "ipv6"], // リンクローカル
  ["ff00::", 8, "ipv6"], // マルチキャスト
];

// IPv4射影のアドレス(::ffff:a.b.c.d)は、BlockList がIPv4の規則に照らして判定する。
// 射影の範囲そのものを規則に足すと、逆にIPv4のアドレスがすべて当てはまってしまう。
const internalList = new net.BlockList();
for (const [address, prefix, family] of INTERNAL_SUBNETS) {
  internalList.addSubnet(address, prefix, family);
}

/**
 * 内部のアドレスなら true。IPアドレスとして読めない文字列も true にする
 * (判定できないものは通さない)。
 */
export function isInternalAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return internalList.check(address, "ipv4");
  if (family === 6) return internalList.check(address, "ipv6");
  return true;
}

export type ConnectTarget =
  | { readonly ok: true; readonly host: string; readonly port: number }
  | { readonly ok: false; readonly reason: string };

/**
 * `CONNECT` の宛先(`host:port` または `[IPv6]:port`)を読む。
 * 通すポートは `allowedPorts` にあるものだけ。
 */
export function parseConnectTarget(
  target: string,
  allowedPorts: readonly number[],
): ConnectTarget {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9._-]+)):(\d{1,5})$/.exec(
    target,
  );
  if (match === null) {
    return { ok: false, reason: "宛先を host:port として読めません" };
  }
  const host = match[1] ?? match[2];
  const port = Number(match[3]);
  if (host === undefined || host === "") {
    return { ok: false, reason: "宛先を host:port として読めません" };
  }
  if (!allowedPorts.includes(port)) {
    return { ok: false, reason: `ポート ${port} は通しません` };
  }
  return { ok: true, host, port };
}

/** 引いたアドレスのうち、最初の外部のアドレスを返す。なければ undefined。 */
export function pickExternalAddress(
  addresses: readonly string[],
  isInternal: (address: string) => boolean = isInternalAddress,
): string | undefined {
  return addresses.find((address) => !isInternal(address));
}
