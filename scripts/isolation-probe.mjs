/**
 * 隔離の確認で、ワーカーのコンテナの中で実行する調査。
 *
 * 見えるもの、できること、届く先を調べて、JSONで標準出力に書く。合否は判定しない
 * (判定は、依頼した側の scripts/isolation-check.ts が行う)。
 *
 * 使い方: node --input-type=module - '<調べる対象のJSON>' < isolation-probe.mjs
 *
 * イメージのビルドの環境を調べるときは、対象のJSONに `build: true` を入れる
 * (scripts/build-check.ts が、Dockerfile の `RUN` から実行する)。作業場所はないので、
 * 作業場所とgitに関する項目は調べない。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

const params = JSON.parse(process.argv[2] ?? "{}");
const TIMEOUT_MS = 4000;

function exists(path) {
  try {
    fs.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      ...options,
    });
    return { ok: true, output: stdout.trim().slice(-400) };
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? null,
      output: String(error.stderr ?? error.message)
        .trim()
        .slice(-400),
    };
  }
}

/** プロキシを通さずに、直接つなぐ。 */
function connectDirect(target) {
  const [host, port] = target.split(/:(?=\d+$)/);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TIMEOUT_MS, () => done("timeout"));
    socket.once("connect", () => done("connected"));
    socket.once("error", (error) => done(`error:${error.code}`));
  });
}

/** プロキシに `CONNECT` を頼み、返ってきた状態コードを返す。 */
function connectViaProxy(target) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  return new Promise((resolve) => {
    const request = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: target,
      timeout: 20_000,
    });
    request.on("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve("timeout");
    });
    request.on("error", (error) => resolve(`error:${error.code}`));
    request.end();
  });
}

function mounts() {
  const pseudo = new Set([
    "proc",
    "sysfs",
    "tmpfs",
    "devpts",
    "mqueue",
    "cgroup",
    "cgroup2",
    "overlay",
  ]);
  return fs
    .readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [left, right] = line.split(" - ");
      return { point: left.split(" ")[4], type: right.split(" ")[0] };
    })
    .filter((mount) => !pseudo.has(mount.type))
    .map((mount) => mount.point)
    .sort();
}

function status(name) {
  const line = fs
    .readFileSync("/proc/self/status", "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}:`));
  return line?.split(":")[1]?.trim() ?? null;
}

function hasDefaultRoute() {
  // 宛先が 00000000 の行が、既定の経路。
  return fs
    .readFileSync("/proc/net/route", "utf8")
    .split("\n")
    .slice(1)
    .some((line) => line.split("\t")[1] === "00000000");
}

function rootWritable() {
  for (const path of ["/probe-write", "/usr/probe-write", "/etc/probe-write"]) {
    try {
      fs.writeFileSync(path, "x");
      fs.rmSync(path);
      return true;
    } catch {
      // 書けないのが正しい。
    }
  }
  return false;
}

function commit() {
  const cwd = "/workspace/repo";
  const identity = [
    "-c",
    "user.name=isolation-check",
    "-c",
    "user.email=isolation-check@example.invalid",
  ];
  if (!exists(`${cwd}/.git`)) {
    const init = run("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd,
    });
    if (!init.ok) return init;
  }
  fs.writeFileSync(`${cwd}/probe.txt`, `${new Date().toISOString()}\n`);
  const add = run("git", ["add", "probe.txt"], { cwd });
  if (!add.ok) return add;
  const committed = run(
    "git",
    [...identity, "commit", "--quiet", "--message=probe"],
    { cwd },
  );
  if (!committed.ok) return committed;
  return run("git", ["log", "--oneline", "-1"], { cwd });
}

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const direct = {};
for (const target of params.directTargets ?? []) {
  direct[target] = await connectDirect(target);
}
const viaProxy = {};
for (const target of params.proxyTargets ?? []) {
  viaProxy[target] = await connectViaProxy(target);
}

/** 作業場所とgitに関する項目。ビルドの環境では調べない。 */
function workspaceChecks() {
  return {
    workspaceEntries: fs.readdirSync("/workspace").sort(),
    marker: fs.readFileSync("/workspace/marker.txt", "utf8").trim(),
    rootWritable: rootWritable(),
    commit: commit(),
    push: run(
      "git",
      ["push", params.pushUrl, "HEAD:refs/heads/isolation-check"],
      {
        cwd: "/workspace/repo",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    ),
    gh: run("gh", ["auth", "status"]),
    claudeVersion: run("claude", ["--version"]),
    lsRemote: run("git", ["ls-remote", params.publicRepoUrl, "HEAD"]),
  };
}

const result = {
  env: Object.keys(process.env).sort(),
  // 値そのものは出さない。トークンが混ざっていないかを、ハッシュで確かめられるようにする。
  envValueSha256: Object.values(process.env).map((value) =>
    createHash("sha256").update(value).digest("hex"),
  ),
  claudeTokenSha256:
    token === undefined
      ? null
      : createHash("sha256").update(token).digest("hex"),
  uid: process.getuid(),
  capEff: status("CapEff"),
  noNewPrivs: status("NoNewPrivs"),
  readable: Object.fromEntries(
    (params.readPaths ?? []).map((path) => [path, exists(path)]),
  ),
  mounts: mounts(),
  defaultRoute: hasDefaultRoute(),
  direct,
  viaProxy,
  ...(params.build === true ? {} : workspaceChecks()),
};

process.stdout.write(`${JSON.stringify(result)}\n`);
