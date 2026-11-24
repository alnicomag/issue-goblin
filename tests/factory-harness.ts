/**
 * 実行を通しで試すための土台。
 *
 * GitHubと、ワーカー(Claude)と、起動係は偽の実装にする。gitは本物を、手元の一時ディレクトリで使う。
 * ネットワークには出ない。
 */
import fs from "node:fs";
import path from "node:path";
import type {
  WorkerCall,
  WorkerInvocation,
  WorkerInvoker,
} from "../src/agents/worker.ts";
import type { WorkerLauncher } from "../src/launcher/client.ts";
import type { RunRequestInput, RunResult } from "../src/launcher/request.ts";
import type { Clock } from "../src/office/clock.ts";
import { type Db, migrate, openDb } from "../src/office/db.ts";
import { createGit } from "../src/office/git.ts";
import { createRepoLocks, type RepoLocks } from "../src/office/locks.ts";
import type { LogFields, Logger } from "../src/office/log.ts";
import type { RunnerDeps } from "../src/office/runner.ts";
import { createSupervisor, type Supervisor } from "../src/office/supervisor.ts";
import { syncAll } from "../src/office/sync.ts";
import {
  branchFor,
  type WorkspaceDirs,
  workspacePaths,
} from "../src/office/workspace.ts";
import { FakeGitHub, VALID_FACTORY_YML } from "./fake-github.ts";
import { makeRepo, makeTempDir, unconfiguredGit } from "./git-fixtures.ts";

export const REPO = "owner/name";
export const AUTHOR = {
  name: "Example Worker",
  email: "worker@example.invalid",
};
/** `VALID_FACTORY_YML` の `allowed_authors` にいる起票者。 */
export const ALLOWED_AUTHOR = "example-login";

export interface LogLine {
  level: string;
  event: string;
  fields: LogFields;
}

type WorkerAnswer = Pick<WorkerInvocation, "status" | "summary">;
type WorkerScript = (
  call: WorkerCall,
) => WorkerAnswer | undefined | Promise<WorkerAnswer | undefined>;

/**
 * 偽のワーカー。指示書ごとに決めた結果を返す。
 * 何も決めていなければ、plan と review は `done` を返し、implement は作業場所にコミットを1つ作って `done` を返す。
 */
export class FakeWorker implements WorkerInvoker {
  readonly calls: WorkerCall[] = [];
  /** 指示書ごとの、返す結果。関数が何も返さなければ、既定の動きをする。 */
  readonly scripts = new Map<string, WorkerScript>();
  private commits = 0;
  private readonly dirs: WorkspaceDirs;

  constructor(dirs: WorkspaceDirs) {
    this.dirs = dirs;
  }

  /** 指示書 `prompt` の呼び出しに、順に `answers` を返す。尽きたら、既定の動きに戻る。 */
  answer(prompt: string, ...answers: WorkerAnswer[]): void {
    const queue = [...answers];
    this.scripts.set(prompt, () => queue.shift());
  }

  callsOf(prompt: string): WorkerCall[] {
    return this.calls.filter((call) => call.prompt === prompt);
  }

  async invoke(call: WorkerCall): Promise<WorkerInvocation> {
    this.calls.push(call);
    const scripted = await this.scripts.get(call.prompt)?.(call);
    const answer = scripted ?? this.defaultAnswer(call);
    return {
      ...answer,
      sessionId: `session-${this.calls.length}`,
      costUsd: 0.01,
      numTurns: 3,
      logPath: `/nonexistent/${call.step}-${this.calls.length}.log`,
      interrupted: false,
    };
  }

  /** 作業場所に、コミットを1つ作る。 */
  commit(repo: string, issue: number): string {
    const { repoDir } = workspacePaths(this.dirs, repo, issue);
    this.commits += 1;
    const name = `feature-${issue}-${this.commits}.txt`;
    fs.writeFileSync(path.join(repoDir, name), `change ${this.commits}\n`);
    unconfiguredGit(repoDir, "add", "--", name);
    unconfiguredGit(repoDir, "commit", "--quiet", "-m", `add ${name}`);
    return unconfiguredGit(repoDir, "rev-parse", "HEAD");
  }

  /** 作業場所に、パス `file` のファイルを足すコミットを作る。 */
  commitPath(repo: string, issue: number, file: string): string {
    const { repoDir } = workspacePaths(this.dirs, repo, issue);
    const target = path.join(repoDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.commits += 1;
    fs.writeFileSync(target, `content ${this.commits} of ${file}\n`);
    unconfiguredGit(repoDir, "add", "--", file);
    unconfiguredGit(repoDir, "commit", "--quiet", "-m", `add ${file}`);
    return unconfiguredGit(repoDir, "rev-parse", "HEAD");
  }

  private defaultAnswer(call: WorkerCall): WorkerAnswer {
    if (call.prompt === "implement") {
      this.commit(call.repo, call.issue);
    }
    return { status: "done", summary: `${call.prompt} の結果` };
  }
}

/**
 * 偽の起動係。検査コマンド(`sh -c` の中身)ごとに決めた結果を、順に返す。
 * 作業場所の状態の確認(`git status`)には、作業用のブランチが取り出されていて、きれいだと返す。
 */
export class FakeLauncher implements WorkerLauncher {
  readonly requests: RunRequestInput[] = [];
  private readonly answers = new Map<string, Partial<RunResult>[]>();

  /** コマンド `command` の実行に、順に `results` を返す。尽きたら、成功を返す。 */
  answer(command: string, ...results: Partial<RunResult>[]): void {
    this.answers.set(command, [...results]);
  }

  run(request: RunRequestInput): Promise<RunResult> {
    this.requests.push(request);
    const next = this.answers.get(request.argv[2] ?? "")?.shift();
    return Promise.resolve({
      exit_code: 0,
      timed_out: false,
      stdout:
        request.argv[0] === "git" ? `## ${branchFor(request.issue)}\0` : "",
      stderr: "",
      truncated: false,
      ...next,
    });
  }

  /** 実行した検査コマンド(作業場所の状態の確認は含まない)。 */
  get commands(): string[] {
    return this.requests
      .filter((request) => request.argv[0] === "sh")
      .map((request) => request.argv[2] ?? "");
  }
}

export interface Harness {
  readonly tmp: string;
  readonly db: Db;
  /** 読むたびに1秒進む時計。`time` を書き換えると、そこから進む。 */
  readonly clock: Clock & { time: string };
  readonly logs: LogLine[];
  readonly logger: Logger;
  /** ログが1行出るたびに呼ばれる。 */
  onLog: (line: LogLine) => void;
  readonly fake: FakeGitHub;
  readonly worker: FakeWorker;
  readonly launcher: FakeLauncher;
  readonly dirs: WorkspaceDirs;
  /** 仮の取得元(手元のリポジトリ)。 */
  readonly source: string;
  readonly locks: RepoLocks;
  dryRun: boolean;
  readonly runner: RunnerDeps;
  /** GitHubの内容をDBに取り込む。 */
  sync(): Promise<void>;
  /** 偽のGitHubにイシューを置く(起票者は、許可された人)。 */
  putIssue(
    number: number,
    overrides?: {
      labels?: string[];
      author?: string;
      open?: boolean;
      body?: string;
    },
  ): void;
  /** 偽のGitHubにある、イシューのラベル。 */
  labels(number: number): readonly string[];
  /** DBにある、イシューの状態。 */
  state(number: number): string;
  newSupervisor(options?: { dailyRunLimit?: number }): Supervisor;
  cleanup(): void;
}

export function createHarness(
  options: { dryRun?: boolean; start?: string } = {},
): Harness {
  const tmp = makeTempDir();
  const db = openDb(":memory:");
  const clock = {
    time: options.start ?? "2026-03-01T01:00:00.000Z",
    now() {
      const now = new Date(clock.time);
      clock.time = new Date(now.getTime() + 1000).toISOString();
      return now;
    },
  };
  migrate(db, { clock });

  const logs: LogLine[] = [];
  const harness = {} as { onLog: (line: LogLine) => void };
  harness.onLog = () => {};
  const push =
    (level: string) =>
    (event: string, fields: LogFields = {}) => {
      const line = { level, event, fields };
      logs.push(line);
      harness.onLog(line);
    };
  const logger: Logger = {
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };

  const fake = new FakeGitHub();
  fake.file = { sha: "sha-1", content: VALID_FACTORY_YML };
  const source = makeRepo(path.join(tmp, "source"));
  const dirs: WorkspaceDirs = {
    reposDir: path.join(tmp, "data", "repos"),
    workDir: path.join(tmp, "work"),
  };
  const worker = new FakeWorker(dirs);
  const launcher = new FakeLauncher();
  const locks = createRepoLocks();

  let issueClock = Date.parse("2026-03-01T00:00:00.000Z");
  const nextIssueTime = () => {
    // 偽のGitHubは、書き込みのたびに更新時刻を進める。それより後の時刻にする。
    const latest = Math.max(
      issueClock,
      ...fake.issues.map((issue) => Date.parse(issue.updatedAt)),
    );
    issueClock = latest + 60_000;
    return new Date(issueClock).toISOString();
  };

  const self: Harness = {
    tmp,
    db,
    clock,
    logs,
    logger,
    get onLog() {
      return harness.onLog;
    },
    set onLog(value) {
      harness.onLog = value;
    },
    fake,
    worker,
    launcher,
    dirs,
    source,
    locks,
    dryRun: options.dryRun ?? false,
    runner: {
      db,
      clock,
      logger,
      git: createGit(),
      dirs,
      logsDir: path.join(tmp, "data", "logs"),
      commitAuthor: AUTHOR,
      retryWaitMinutes: [5, 30, 120],
      launcher,
      createWorker: () => worker,
      sourceFor: () => ({ url: source }),
      writeFor: () => ({ api: fake, dryRun: self.dryRun, logger }),
    },
    async sync() {
      const [result] = await syncAll(
        { db, apiFor: () => fake, dryRun: self.dryRun, clock, logger, locks },
        [REPO],
      );
      if (!result?.ok) throw new Error("同期に失敗しました");
    },
    putIssue(number, overrides = {}) {
      fake.putIssue({
        number,
        author: ALLOWED_AUTHOR,
        labels: ["state:ready"],
        ...overrides,
        updatedAt: nextIssueTime(),
      });
    },
    labels(number) {
      return fake.issues.find((issue) => issue.number === number)?.labels ?? [];
    },
    state(number) {
      const row = db
        .prepare("SELECT state FROM issues WHERE repo = ? AND number = ?")
        .get(REPO, number) as { state: string } | undefined;
      if (row === undefined) throw new Error(`イシューがありません: ${number}`);
      return row.state;
    },
    newSupervisor(supervisorOptions = {}) {
      return createSupervisor({
        runner: self.runner,
        locks,
        dailyRunLimit: supervisorOptions.dailyRunLimit ?? 20,
        dryRun: self.dryRun,
      });
    },
    cleanup() {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  return self;
}
