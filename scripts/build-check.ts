/**
 * 製品のイメージのビルドの確認。事務局のコンテナの中で実行する。
 *
 * 起動係を通して、仮の製品の Dockerfile を実際にビルドし、ビルドの環境(`RUN` の中)から
 * 見えるもの、届く先を調べる。あわせて、ビルドしたイメージでワーカーと verify が動くこと、
 * 作り直さないこと、作業場所の Dockerfile が使われないこと、ビルドできない Dockerfile の扱いを確かめて、
 * 項目ごとに合否を出す。1つでも不合格なら、終了コード1で終わる。
 *
 * ビルドの環境の調査は、Dockerfile の `RUN` で scripts/isolation-probe.mjs を実行し、
 * 結果をイメージの中のファイルに残して、後から読む。
 *
 * 作業場所に確認用のディレクトリを作り、イメージをビルドするので、稼働中の環境ではなく、
 * scripts/check-isolation.sh が立てる確認用の環境で実行すること。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLauncherClient } from "../src/launcher/client.ts";
import { BUILDER_PROBE_DOCKERFILE } from "../src/launcher/image.ts";
import { systemClock } from "../src/office/clock.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/office/config.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { createGit } from "../src/office/git.ts";
import {
  FactoryYmlSchema,
  readStoredWorkerDockerfile,
} from "../src/office/product.ts";
import {
  ImageBuildError,
  withProductImage,
} from "../src/office/product-image.ts";
import { runVerify } from "../src/office/verify.ts";
import {
  branchFor,
  cleanupWorkspace,
  workspacePaths,
} from "../src/office/workspace.ts";

/** 確認に使うイシュー番号。ほかの確認が使う番号と重ならないようにする。 */
const ISSUE = 902;
const DOCKERFILE_PATH = ".factory/worker.Dockerfile";
const PROBE_FILE = "/build-probe.json";
const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

interface BuildProbe {
  env: string[];
  envValueSha256: string[];
  uid: number;
  readable: Record<string, boolean>;
  mounts: string[];
  defaultRoute: boolean;
  direct: Record<string, string>;
  viaProxy: Record<string, number | string>;
}

/** ビルドの `RUN` の環境変数として、あってよい名前。これ以外があれば不合格にする。 */
const ALLOWED_BUILD_ENV = [
  "FACTORY_BASE_IMAGE", // Dockerfile が宣言したビルド引数
  "HOME",
  "HOSTNAME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_VERSION", // 基本イメージが定義している
  "PATH",
  "PWD",
  "YARN_VERSION", // 基本イメージが定義している
  "http_proxy",
  "https_proxy",
];

/** ビルドから見えてはいけない場所(事務局と起動係の持ち物、作業場所)。 */
const HIDDEN_PATHS = [
  "/data",
  "/data/factory.db",
  "/app",
  "/app/.env",
  "/app/config/factory.config.yml",
  "/work",
  "/workspace/repo",
  "/workspace/home",
  "/run/launcher",
  "/run/launcher/launcher.sock",
  "/var/run/docker.sock",
  "/run/docker.sock",
];
/** Dockerがコンテナに差し込むファイル。 */
const DOCKER_FILES = ["/etc/hostname", "/etc/hosts", "/etc/resolv.conf"];

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

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const base64 = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64");

/** 基本イメージだけの Dockerfile。確認用の Dockerfile の先頭に使う。 */
const BASE = BUILDER_PROBE_DOCKERFILE;

/** ビルドの環境を調べて、結果をイメージの中に残す Dockerfile。 */
function probeDockerfile(probeScript: string, params: unknown): string {
  return [
    "# 確認用。ビルドの環境を調べて、結果をイメージに残す。",
    BASE.trimEnd(),
    "USER root",
    `RUN echo ${base64(probeScript)} | base64 -d > /tmp/probe.mjs \\`,
    `  && echo ${base64(JSON.stringify(params))} | base64 -d > /tmp/probe.json \\`,
    `  && node /tmp/probe.mjs "$(cat /tmp/probe.json)" > ${PROBE_FILE} \\`,
    "  && rm /tmp/probe.mjs /tmp/probe.json",
    "USER node",
    "",
  ].join("\n");
}

/** 仮の製品を保存する。`dockerfile` が null なら、Dockerfile のない製品にする。 */
function setProduct(
  db: Db,
  repo: string,
  commands: { setup: string; test: string; lint: string },
  dockerfile: string | null,
): void {
  const factoryYml = FactoryYmlSchema.parse({
    version: 1,
    level: "A",
    commands,
    issues: { allowed_authors: [] },
    ...(dockerfile === null ? {} : { worker: { dockerfile: DOCKERFILE_PATH } }),
  });
  db.prepare(
    `INSERT INTO repos
       (repo, factory_yml, factory_yml_sha, worker_dockerfile,
        worker_dockerfile_sha, worker_dockerfile_path)
     VALUES (?, ?, 'check', ?, ?, ?)
     ON CONFLICT (repo) DO UPDATE SET
       factory_yml = excluded.factory_yml,
       worker_dockerfile = excluded.worker_dockerfile,
       worker_dockerfile_sha = excluded.worker_dockerfile_sha,
       worker_dockerfile_path = excluded.worker_dockerfile_path`,
  ).run(
    repo,
    JSON.stringify(factoryYml),
    dockerfile,
    dockerfile === null ? null : sha256(dockerfile),
    dockerfile === null ? null : DOCKERFILE_PATH,
  );
}

const NO_COMMANDS = { setup: "true", test: "true", lint: "true" };

async function main(): Promise<void> {
  const config = loadConfig(process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG_PATH);
  const [first] = config.repos;
  if (first === undefined) {
    throw new Error("確認には、設定にリポジトリが1つ要ります");
  }
  const repo = first.repo;
  const hostTarget = requireEnv("CHECK_HOST_ADDR");
  const containerTarget = requireEnv("CHECK_CONTAINER_ADDR");
  const hostAddress = requireEnv("CHECK_HOST_IP");
  const claudeTokenHash = requireEnv("CHECK_CLAUDE_TOKEN_SHA256");
  const dirs = { reposDir: config.repos_dir, workDir: config.work_dir };
  const paths = workspacePaths(dirs, repo, ISSUE);
  // DBは、この確認の中だけのものを使う(事務局のDBファイルには触れない)。
  const db = openDb(":memory:");
  migrate(db, { clock: systemClock });
  // 事務局と同じ組み立て。保存してある Dockerfile を、依頼に添える。
  const launcher = withProductImage(
    createLauncherClient({ socketPath: requireEnv("LAUNCHER_SOCKET") }),
    (target) => readStoredWorkerDockerfile(db, target),
  );
  const request = (argv: string[], claudeToken = false) =>
    launcher.run({
      repo,
      issue: ISSUE,
      argv,
      claude_token: claudeToken,
      timeout_sec: 120,
    });

  const probeScript = fs.readFileSync(
    path.join(import.meta.dirname, "isolation-probe.mjs"),
    "utf8",
  );
  const containerHost = containerTarget.slice(
    0,
    containerTarget.lastIndexOf(":"),
  );
  const probing = probeDockerfile(probeScript, {
    build: true,
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
      `${containerHost}:443`,
      "github.com:443",
    ],
  });

  // 確認用のcloneを作る(verify-check.ts と同じ形)。
  const branch = branchFor(ISSUE);
  const git = createGit();
  const commit = async (message: string) => {
    await git.run(["add", "--all"], { cwd: paths.repoDir });
    await git.run(
      [
        "-c",
        "user.name=Example",
        "-c",
        "user.email=example@example.invalid",
        "commit",
        "--quiet",
        "-m",
        message,
      ],
      { cwd: paths.repoDir },
    );
  };
  cleanupWorkspace({ dirs, repo, issue: ISSUE });
  fs.mkdirSync(paths.repoDir, { recursive: true });
  fs.mkdirSync(paths.homeDir, { recursive: true });
  await git.run(["init", "--quiet", `--initial-branch=${branch}`, "--", "."], {
    cwd: paths.repoDir,
  });
  fs.writeFileSync(`${paths.repoDir}/README.md`, "check\n");
  await commit("check");
  const logs: string[] = [];

  try {
    console.log("# Dockerfile のない製品");
    setProduct(db, repo, NO_COMMANDS, null);
    const plain = await request(["test", "-e", PROBE_FILE]);
    report(
      plain.build === undefined && plain.exit_code !== 0,
      "worker.dockerfile を書いていない製品は、ビルドせず、設定のイメージで動く",
      JSON.stringify({ build: plain.build, exit_code: plain.exit_code }),
    );

    console.log("\n# ビルドと、ビルドしたイメージでの実行");
    setProduct(db, repo, NO_COMMANDS, probing);
    const built = await request(["cat", PROBE_FILE]);
    report(
      built.build === "built" && built.exit_code === 0,
      "worker.dockerfile を書いた製品は、そこからビルドしたイメージで動く",
      `${built.build} ${built.exit_code} ${built.stderr.slice(-400)}`,
    );
    const probe = JSON.parse(built.stdout) as BuildProbe;

    const withToken = await request(
      [
        "sh",
        "-c",
        `test -e ${PROBE_FILE} && test -n "\${${CLAUDE_TOKEN_ENV}:-}" && id -u`,
      ],
      true,
    );
    report(
      withToken.exit_code === 0 && withToken.stdout.trim() === "1000",
      "Claudeを呼ぶステップ(トークンを渡す依頼)も、同じイメージで、同じユーザーで動く",
      `${withToken.exit_code} ${withToken.stdout.trim()}`,
    );

    setProduct(
      db,
      repo,
      { setup: `test -e ${PROBE_FILE}`, test: "id -u", lint: "true" },
      probing,
    );
    const verified = await runVerify(
      { db, launcher, dirs, logsDir: config.logs_dir },
      { repo, issue: ISSUE, timeoutSec: 120 },
    );
    logs.push(verified.logPath);
    report(
      verified.outcome === "done" && verified.passed,
      "verify の検査コマンドが、ビルドしたイメージで動く",
      verified.summary,
    );

    console.log("\n# ビルドの環境(RUN の中)");
    report(
      probe.uid === 0,
      "前提: 調査は、ビルドの RUN の中で動いた(root)",
      String(probe.uid),
    );
    const extraEnv = probe.env.filter(
      (name) => !ALLOWED_BUILD_ENV.includes(name),
    );
    report(
      extraEnv.length === 0,
      "環境変数が、決まった一覧だけである",
      extraEnv.join(", "),
    );
    const officeSecrets = Object.entries(process.env)
      .filter(([name]) => name.startsWith("GITHUB_TOKEN"))
      .map(([, value]) => sha256(value ?? ""));
    report(
      officeSecrets.length > 0 &&
        !probe.env.some((name) => name.startsWith("GITHUB")) &&
        !officeSecrets.some((hash) => probe.envValueSha256.includes(hash)),
      "ビルドの環境に、GitHubのトークンがない",
    );
    report(
      !probe.env.some((name) => name.includes("CLAUDE")) &&
        !probe.envValueSha256.includes(claudeTokenHash),
      "ビルドの環境に、Claudeのトークンがない",
    );
    const visible = Object.entries(probe.readable).filter(([, seen]) => seen);
    report(
      visible.length === 0,
      "ビルドから、DB、設定ファイル、ソケット、作業場所が見えない",
      visible.map(([name]) => name).join(", "),
    );
    report(
      JSON.stringify(probe.mounts) === JSON.stringify([...DOCKER_FILES].sort()),
      "ビルドのコンテナに、マウントがない",
      probe.mounts.join(", "),
    );
    report(!probe.defaultRoute, "ビルドに、外への経路(既定の経路)がない");
    for (const [name, target] of [
      ["インスタンスメタデータ", "169.254.169.254:80"],
      ["ホスト", hostTarget],
      ["ホスト(22番)", `${hostAddress}:22`],
      ["ほかのコンテナ", containerTarget],
      ["外部", "1.1.1.1:443"],
    ] as const) {
      report(
        probe.direct[target] !== undefined &&
          probe.direct[target] !== "connected",
        `ビルドから、${name}(${target})に、直接は届かない`,
        String(probe.direct[target]),
      );
    }
    for (const [name, target] of [
      ["インスタンスメタデータ", "169.254.169.254:443"],
      ["インスタンスメタデータ(80番)", "169.254.169.254:80"],
      ["ホスト", hostTarget],
      ["ホスト(443番)", `${hostAddress}:443`],
      ["ほかのコンテナ", `${containerHost}:443`],
    ] as const) {
      report(
        probe.viaProxy[target] === 403,
        `ビルドから、プロキシを通しても、${name}(${target})には届かない`,
        String(probe.viaProxy[target]),
      );
    }
    report(
      probe.viaProxy["github.com:443"] === 200,
      "ビルドから、プロキシを通して、外部のHTTPSに届く(github.com:443)",
      String(probe.viaProxy["github.com:443"]),
    );

    console.log("\n# 作り直さないこと");
    const again = await request(["cat", PROBE_FILE]);
    report(
      again.build === "cached" && again.stdout === built.stdout,
      "Dockerfile と基本イメージが変わらなければ、ビルドし直さず、同じイメージで動く",
      String(again.build),
    );

    console.log("\n# 作業用のブランチの Dockerfile");
    // ワーカーが、作業場所の Dockerfile を書き換えてコミットする。
    fs.mkdirSync(path.dirname(`${paths.repoDir}/${DOCKERFILE_PATH}`), {
      recursive: true,
    });
    fs.writeFileSync(
      `${paths.repoDir}/${DOCKERFILE_PATH}`,
      `${BASE}RUN touch /changed-by-worker\n`,
    );
    await commit("change the worker dockerfile");
    const afterChange = await request([
      "sh",
      "-c",
      `test ! -e /changed-by-worker && cat ${PROBE_FILE}`,
    ]);
    report(
      afterChange.build === "cached" &&
        afterChange.exit_code === 0 &&
        afterChange.stdout === built.stdout,
      "作業用のブランチで Dockerfile を変えても、その実行のイメージは変わらない",
      `${afterChange.build} ${afterChange.exit_code}`,
    );

    console.log("\n# ビルドできない Dockerfile");
    const failing = async (
      dockerfile: string,
    ): Promise<ImageBuildError | string> => {
      setProduct(db, repo, NO_COMMANDS, dockerfile);
      try {
        const result = await request(["true"]);
        return `ビルドできてしまいました(${result.build})`;
      } catch (error) {
        return error instanceof ImageBuildError ? error : String(error);
      }
    };
    for (const [name, dockerfile, reason] of [
      [
        "ADD でインスタンスメタデータを取得する",
        `${BASE}ADD http://169.254.169.254/latest/meta-data/ /meta\n`,
        "ADD は使えません",
      ],
      [
        "基本イメージのほかのイメージを土台にする",
        "FROM busybox:1.37\n",
        "FROM に書けるのは",
      ],
      [
        "ほかのイメージからコピーする",
        `${BASE}COPY --from=busybox:1.37 /bin/sh /sh\n`,
        "前の段の名前だけです",
      ],
    ] as const) {
      const outcome = await failing(dockerfile);
      report(
        outcome instanceof ImageBuildError &&
          outcome.exitCode === null &&
          outcome.output.includes(reason),
        `${name} Dockerfile は、ビルドを始めずに断る`,
        String(outcome),
      );
    }
    const broken = await failing(`${BASE}RUN echo build-broken; exit 7\n`);
    report(
      broken instanceof ImageBuildError &&
        broken.exitCode !== null &&
        broken.exitCode !== 0 &&
        broken.output.includes("build-broken"),
      "RUN が失敗する Dockerfile は、ビルドの失敗として、出力とあわせて返る(コマンドは実行しない)",
      String(broken),
    );

    console.log("\n# apt と、古いイメージの片付け");
    // 基本イメージの apt の取得元はHTTPSなので、プロキシ(443番だけ)を通って取得できる。
    setProduct(
      db,
      repo,
      NO_COMMANDS,
      `${BASE}USER root\nRUN apt-get update && rm -rf /var/lib/apt/lists/*\nUSER node\n`,
    );
    const apt = await request(["test", "!", "-e", PROBE_FILE]).catch(
      (error: unknown) => error,
    );
    report(
      !(apt instanceof Error) &&
        (apt as { build?: string }).build === "built" &&
        (apt as { exit_code: number | null }).exit_code === 0,
      "製品の Dockerfile から、プロキシを通して apt を使える。Dockerfile が変わると、ビルドし直す",
      apt instanceof Error ? apt.message.slice(-600) : JSON.stringify(apt),
    );
  } finally {
    cleanupWorkspace({ dirs, repo, issue: ISSUE });
    for (const log of logs) fs.rmSync(log, { force: true });
  }

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
