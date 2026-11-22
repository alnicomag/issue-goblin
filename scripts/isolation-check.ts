/**
 * ワーカーの隔離の確認。事務局のコンテナの中で実行する。
 *
 * 起動係を通してワーカーのコンテナを立て、中から見えるもの、できること、届く先を調べて、
 * 項目ごとに合否を出す。1つでも不合格なら、終了コード1で終わる。
 *
 * 作業場所に確認用のディレクトリを作るので、稼働中の環境ではなく、
 * scripts/check-isolation.sh が立てる確認用の環境で実行すること。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createLauncherClient } from "../src/launcher/client.ts";
import { issueDirFor } from "../src/launcher/container.ts";
import type { RunRequestInput } from "../src/launcher/request.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/office/config.ts";

interface Probe {
  env: string[];
  claudeTokenSha256: string | null;
  uid: number;
  capEff: string | null;
  noNewPrivs: string | null;
  readable: Record<string, boolean>;
  mounts: string[];
  workspaceEntries: string[];
  marker: string;
  rootWritable: boolean;
  commit: { ok: boolean; output: string };
  push: { ok: boolean; output: string };
  gh: { ok: boolean; code: string | null; output: string };
  claudeVersion: { ok: boolean; output: string };
  defaultRoute: boolean;
  direct: Record<string, string>;
  viaProxy: Record<string, number | string>;
  lsRemote: { ok: boolean; output: string };
}

/** ワーカーの環境変数として、あってよい名前。これ以外があれば不合格にする。 */
const ALLOWED_ENV = [
  "HOME",
  "HOSTNAME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_VERSION", // イメージが定義している
  "PATH",
  "PWD", // 作業ディレクトリ。コンテナの起動時に入る
  "YARN_VERSION", // イメージが定義している
  "http_proxy",
  "https_proxy",
];
const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** ワーカーから見えてはいけない場所(事務局と起動係の持ち物)。 */
const HIDDEN_PATHS = [
  "/data",
  "/data/factory.db",
  "/app",
  "/app/.env",
  "/app/config/factory.config.yml",
  "/work",
  "/run/launcher",
  "/run/launcher/launcher.sock",
  "/var/run/docker.sock",
];

/** コンテナに必ずある、Dockerが差し込むファイル。 */
const DOCKER_FILES = [
  "/etc/hostname",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/usr/sbin/docker-init", // --init で入る、子プロセスの後始末役
];

let failures = 0;
function report(ok: boolean, item: string, detail = ""): void {
  if (!ok) failures += 1;
  const suffix = detail === "" ? "" : `: ${detail}`;
  console.log(`${ok ? "OK" : "NG"}  ${item}${ok ? "" : suffix}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`環境変数 ${name} がありません`);
  }
  return value;
}

function canConnect(target: string): Promise<boolean> {
  const index = target.lastIndexOf(":");
  return new Promise((resolve) => {
    const socket = net.connect({
      host: target.slice(0, index),
      port: Number(target.slice(index + 1)),
    });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(4000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const [first, second] = config.repos;
  if (first === undefined || second === undefined) {
    throw new Error("確認には、設定にリポジトリが2つ要ります");
  }
  const workDir = process.env.CHECK_WORK_DIR ?? "/work";
  const hostTarget = requireEnv("CHECK_HOST_ADDR");
  const containerTarget = requireEnv("CHECK_CONTAINER_ADDR");
  const hostAddress = requireEnv("CHECK_HOST_IP");
  const expectedTokenHash = requireEnv("CHECK_CLAUDE_TOKEN_SHA256");
  const launcher = createLauncherClient({
    socketPath: requireEnv("LAUNCHER_SOCKET"),
  });
  const probeScript = fs.readFileSync(
    path.join(import.meta.dirname, "isolation-probe.mjs"),
    "utf8",
  );

  // 前提: 待ち受けには、ふつうのコンテナ(事務局)からは届く。
  // これが成り立たないと、「ワーカーから届かない」ことの確認が意味を持たない。
  report(
    await canConnect(hostTarget),
    `前提: ホストの待ち受け(${hostTarget})に、事務局のコンテナからは届く`,
  );
  report(
    await canConnect(containerTarget),
    `前提: ほかのコンテナ(${containerTarget})に、事務局のコンテナからは届く`,
  );
  // 前提: 事務局はGitHubのトークンを持っている(ワーカーに渡っていないことを確かめる相手)。
  report(
    Object.keys(process.env).some((name) => name.startsWith("GITHUB_TOKEN")),
    "前提: 事務局の環境変数には、GitHubのトークンがある",
  );

  console.log("\n# 事務局のコンテナ");
  report(
    !fs.existsSync("/var/run/docker.sock") &&
      !fs.existsSync("/run/docker.sock"),
    "事務局のコンテナに、Dockerソケットがない",
  );
  report(
    process.env[CLAUDE_TOKEN_ENV] === undefined,
    "事務局の環境変数に、Claudeのトークンがない",
  );

  // 作業場所を3つ用意する(同じ製品の別のイシューと、別の製品)。
  const places = [
    { repo: first.repo, issue: 1 },
    { repo: first.repo, issue: 2 },
    { repo: second.repo, issue: 1 },
  ].map((place) => ({
    ...place,
    marker: `${place.repo}#${place.issue}`,
    dir: path.join(workDir, issueDirFor(place.repo, place.issue)),
  }));
  for (const place of places) {
    fs.mkdirSync(path.join(place.dir, "repo"), { recursive: true });
    fs.mkdirSync(path.join(place.dir, "home"), { recursive: true });
    fs.writeFileSync(path.join(place.dir, "marker.txt"), `${place.marker}\n`);
  }

  const params = {
    readPaths: HIDDEN_PATHS,
    directTargets: [
      "169.254.169.254:80",
      hostTarget,
      `${hostAddress}:22`,
      containerTarget,
      "1.1.1.1:443",
    ],
    proxyTargets: [
      "169.254.169.254:443",
      "169.254.169.254:80",
      hostTarget,
      `${hostAddress}:443`,
      `${containerTarget.slice(0, containerTarget.lastIndexOf(":"))}:443`,
      "github.com:443",
    ],
    pushUrl: `https://github.com/${first.repo}.git`,
    publicRepoUrl: "https://github.com/git/git.git",
  };

  async function probe(
    place: { repo: string; issue: number },
    claudeToken: boolean,
  ): Promise<Probe> {
    const request: RunRequestInput = {
      repo: place.repo,
      issue: place.issue,
      argv: ["node", "--input-type=module", "-", JSON.stringify(params)],
      stdin: probeScript,
      claude_token: claudeToken,
      timeout_sec: 300,
    };
    const result = await launcher.run(request);
    if (result.exit_code !== 0) {
      throw new Error(
        `調査が失敗しました(終了コード ${result.exit_code}): ${result.stderr.slice(-800)}`,
      );
    }
    return JSON.parse(result.stdout) as Probe;
  }

  const [placeA1, placeA2, placeB1] = places;
  if (placeA1 === undefined || placeA2 === undefined || placeB1 === undefined) {
    throw new Error("作業場所を用意できませんでした");
  }
  const a1 = await probe(placeA1, false);

  console.log("\n# ワーカーから見えるもの");
  const hidden = Object.entries(a1.readable).filter(([, visible]) => visible);
  report(
    hidden.length === 0,
    "事務局のDBファイル、.env、設定ファイル、ソケットを読めない",
    hidden.map(([name]) => name).join(", "),
  );
  report(
    JSON.stringify(a1.env) === JSON.stringify([...ALLOWED_ENV].sort()),
    "環境変数が、明示した一覧だけである(GitHubのトークンを含まない)",
    a1.env.join(", "),
  );
  report(
    JSON.stringify(a1.mounts) ===
      JSON.stringify([...DOCKER_FILES, "/workspace"].sort()),
    "マウントされているのは、作業場所だけである",
    a1.mounts.join(", "),
  );
  report(
    a1.marker === placeA1.marker &&
      JSON.stringify(a1.workspaceEntries) ===
        JSON.stringify(["home", "marker.txt", "repo"]),
    "作業場所には、そのイシューのものだけがある",
    `${a1.marker} / ${a1.workspaceEntries.join(", ")}`,
  );
  // ここまでに動いたのは、1つ目の作業場所のワーカーだけ。
  report(
    fs.existsSync(path.join(placeA1.dir, "repo", "probe.txt")) &&
      fs.readdirSync(path.join(placeA2.dir, "repo")).length === 0 &&
      fs.readdirSync(path.join(placeB1.dir, "repo")).length === 0,
    "ワーカーの書き込みは、自分の作業場所にだけ残る(別のイシューと別の製品は空のまま)",
  );
  const a2 = await probe(placeA2, false);
  report(
    a2.marker === placeA2.marker,
    "同じ製品の別のイシューのワーカーには、そのイシューの作業場所だけが見える",
    a2.marker,
  );
  const b1 = await probe(placeB1, false);
  report(
    b1.marker === placeB1.marker,
    "別の製品のワーカーには、その製品の作業場所だけが見える",
    b1.marker,
  );

  console.log("\n# ワーカーにできること");
  report(
    a1.commit.ok,
    "作業場所の中で、ファイルの変更とコミットができる",
    a1.commit.output,
  );
  report(
    fs.existsSync(path.join(placeA1.dir, "repo", ".git")),
    "ワーカーのコミットが、事務局から見える作業場所に残っている",
  );
  report(!a1.rootWritable, "作業場所の外(ルート)には書き込めない");
  report(
    a1.uid === 1000 && /^0+$/.test(a1.capEff ?? "") && a1.noNewPrivs === "1",
    "権限を落として動いている(uid 1000、ケーパビリティなし、no-new-privileges)",
    `uid=${a1.uid} CapEff=${a1.capEff} NoNewPrivs=${a1.noNewPrivs}`,
  );
  report(!a1.push.ok, "git push は、認証できずに失敗する", a1.push.output);
  console.log(`      (git push の出力: ${a1.push.output.split("\n").pop()})`);
  report(
    !a1.gh.ok && a1.gh.code === "ENOENT",
    "gh は入っておらず、実行できない",
    a1.gh.output,
  );
  report(
    a1.claudeVersion.ok,
    "Claude Code が入っている",
    a1.claudeVersion.output,
  );
  console.log(`      (claude --version: ${a1.claudeVersion.output})`);

  console.log("\n# ワーカーから届く先");
  report(!a1.defaultRoute, "外への経路(既定の経路)がない");
  for (const [target, outcome] of Object.entries(a1.direct)) {
    const label =
      target === "169.254.169.254:80"
        ? "インスタンスメタデータ"
        : target === hostTarget || target.startsWith(`${hostAddress}:`)
          ? "ホスト"
          : target === containerTarget
            ? "ほかのコンテナ"
            : "外部";
    report(
      outcome !== "connected",
      `直接には届かない: ${label}(${target})`,
      outcome,
    );
  }
  for (const [target, outcome] of Object.entries(a1.viaProxy)) {
    if (target === "github.com:443") continue;
    report(outcome === 403, `プロキシが拒否する: ${target}`, String(outcome));
  }
  report(
    a1.viaProxy["github.com:443"] === 200,
    "プロキシを通して、外部のHTTPSに届く(github.com:443)",
    String(a1.viaProxy["github.com:443"]),
  );
  report(
    a1.lsRemote.ok,
    "プロキシを通して、gitで公開リポジトリを読める",
    a1.lsRemote.output,
  );

  console.log("\n# Claudeのトークン");
  report(
    a1.claudeTokenSha256 === null,
    "求めていない実行には、トークンが渡らない",
  );
  const withToken = await probe(placeA1, true);
  report(
    withToken.claudeTokenSha256 === expectedTokenHash,
    "求めた実行には、起動係の持つトークンが渡る",
  );
  report(
    JSON.stringify(withToken.env) ===
      JSON.stringify([...ALLOWED_ENV, CLAUDE_TOKEN_ENV].sort()),
    "求めた実行でも、増える環境変数はトークンだけである",
    withToken.env.join(", "),
  );

  console.log("\n# 起動係の検査");
  const rejected = async (
    item: string,
    request: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await launcher.run(request as unknown as RunRequestInput);
      report(false, item, "受け付けられてしまった");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report(message.includes("起動係が依頼を拒否しました"), item, message);
    }
  };
  const base = {
    repo: first.repo,
    issue: 1,
    argv: ["true"],
    timeout_sec: 30,
  };
  await rejected("設定にないリポジトリの依頼を拒否する", {
    ...base,
    repo: "owner/unknown-repository",
  });
  await rejected("置き場所の外を指すリポジトリ名を拒否する", {
    ...base,
    repo: "../..",
  });
  await rejected("マウントを指定する依頼を拒否する", {
    ...base,
    mounts: ["/var/run/docker.sock:/var/run/docker.sock"],
  });
  await rejected("イメージを指定する依頼を拒否する", {
    ...base,
    image: "busybox",
  });
  await rejected("細工したイシュー番号を拒否する", {
    ...base,
    issue: "1/../../second",
  });

  const startedAt = Date.now();
  const slow = await launcher.run({
    repo: first.repo,
    issue: 1,
    argv: ["sleep", "120"],
    timeout_sec: 3,
  });
  const elapsedSec = (Date.now() - startedAt) / 1000;
  report(
    slow.timed_out && elapsedSec < 60,
    "時間の上限を過ぎた実行は、止められて時間切れとして返る",
    `timed_out=${slow.timed_out} ${elapsedSec.toFixed(1)}秒`,
  );

  console.log(
    failures === 0
      ? "\nすべて合格しました"
      : `\n不合格が ${failures} 件あります`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
