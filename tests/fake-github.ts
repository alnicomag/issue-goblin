import type {
  GitHubApi,
  GitHubComment,
  GitHubFileResult,
  GitHubIssue,
  GitHubPullRequest,
  NewPullRequest,
  PullRequestContent,
} from "../src/office/github.ts";

type Call =
  | { method: "listIssues"; repo: string; since: string | null }
  | { method: "listIssueComments"; repo: string; since: string | null }
  | { method: "getFile"; repo: string; path: string; knownSha: string | null }
  | {
      method: "addLabels";
      repo: string;
      issueNumber: number;
      labels: string[];
    }
  | { method: "findOpenPullRequest"; repo: string; head: string }
  | { method: "createPullRequest"; repo: string; input: NewPullRequest }
  | {
      method: "updatePullRequest";
      repo: string;
      number: number;
      content: PullRequestContent;
    }
  | {
      method: "createIssueComment";
      repo: string;
      issueNumber: number;
      body: string;
    };

const WRITE_METHODS: readonly Call["method"][] = [
  "addLabels",
  "createPullRequest",
  "updatePullRequest",
  "createIssueComment",
];

export interface FakePullRequest extends NewPullRequest {
  number: number;
  open: boolean;
}

/** ネットワークに出ない、偽のGitHub。1つのリポジトリの内容をメモリに持つ。 */
export class FakeGitHub implements GitHubApi {
  issues: GitHubIssue[] = [];
  comments: GitHubComment[] = [];
  file: { sha: string; content: string } | null = null;
  /** 設定すると、すべての読み取りがこの例外で失敗する。 */
  failWith: Error | null = null;
  /** 設定すると、書き込みがこの例外で失敗する。 */
  failWritesWith: Error | null = null;
  pullRequests: FakePullRequest[] = [];
  readonly calls: Call[] = [];

  get writes(): Call[] {
    return this.calls.filter((call) => WRITE_METHODS.includes(call.method));
  }

  /** イシューを追加、または同じ番号のものを置き換える。 */
  putIssue(
    issue: Partial<GitHubIssue> & { number: number; updatedAt: string },
  ) {
    const previous = this.issues.find((i) => i.number === issue.number);
    const next: GitHubIssue = {
      title: `Issue ${issue.number}`,
      body: "",
      open: true,
      labels: [],
      author: "someone",
      isPullRequest: false,
      ...previous,
      ...issue,
    };
    this.issues = [
      ...this.issues.filter((i) => i.number !== issue.number),
      next,
    ];
  }

  putComment(
    comment: Partial<GitHubComment> & {
      id: number;
      issueNumber: number;
      updatedAt: string;
    },
  ) {
    const next: GitHubComment = {
      body: "comment",
      author: "someone",
      createdAt: comment.updatedAt,
      onPullRequest: false,
      ...comment,
    };
    this.comments = [...this.comments.filter((c) => c.id !== comment.id), next];
  }

  async listIssues(repo: string, since: string | null) {
    this.calls.push({ method: "listIssues", repo, since });
    if (this.failWith) throw this.failWith;
    // GitHubと同じく、since と同時刻のものも返す。
    return this.issues
      .filter((issue) => since === null || issue.updatedAt >= since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async listIssueComments(repo: string, since: string | null) {
    this.calls.push({ method: "listIssueComments", repo, since });
    if (this.failWith) throw this.failWith;
    return this.comments
      .filter((comment) => since === null || comment.updatedAt >= since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async getFile(
    repo: string,
    path: string,
    knownSha: string | null,
  ): Promise<GitHubFileResult> {
    this.calls.push({ method: "getFile", repo, path, knownSha });
    if (this.failWith) throw this.failWith;
    if (this.file === null) return { status: "missing" };
    if (this.file.sha === knownSha) return { status: "unchanged" };
    return { status: "found", ...this.file };
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]) {
    this.calls.push({ method: "addLabels", repo, issueNumber, labels });
    if (this.failWritesWith) throw this.failWritesWith;
    // 本物と同じく、ラベルを付けるとイシューの更新時刻が進む。
    const issue = this.issues.find((i) => i.number === issueNumber);
    if (issue) {
      const bumped = new Date(Date.parse(issue.updatedAt) + 1000).toISOString();
      this.putIssue({
        number: issueNumber,
        labels: [...issue.labels, ...labels],
        updatedAt: bumped,
      });
    }
  }

  async findOpenPullRequest(
    repo: string,
    head: string,
  ): Promise<GitHubPullRequest | null> {
    this.calls.push({ method: "findOpenPullRequest", repo, head });
    if (this.failWith) throw this.failWith;
    const found = this.pullRequests.find((pr) => pr.open && pr.head === head);
    return found === undefined ? null : this.toPullRequest(repo, found);
  }

  async createPullRequest(
    repo: string,
    input: NewPullRequest,
  ): Promise<GitHubPullRequest> {
    this.calls.push({ method: "createPullRequest", repo, input });
    if (this.failWritesWith) throw this.failWritesWith;
    // 本物と同じく、同じブランチのオープンなPRがあれば断る。
    if (this.pullRequests.some((pr) => pr.open && pr.head === input.head)) {
      throw new Error(`A pull request already exists for ${input.head}`);
    }
    const created: FakePullRequest = {
      ...input,
      number: 100 + this.pullRequests.length,
      open: true,
    };
    this.pullRequests.push(created);
    return this.toPullRequest(repo, created);
  }

  async updatePullRequest(
    repo: string,
    number: number,
    content: PullRequestContent,
  ): Promise<void> {
    this.calls.push({ method: "updatePullRequest", repo, number, content });
    if (this.failWritesWith) throw this.failWritesWith;
    if (!this.pullRequests.some((pr) => pr.number === number)) {
      throw new Error(`No pull request ${number}`);
    }
    this.pullRequests = this.pullRequests.map((pr) =>
      pr.number === number ? { ...pr, ...content } : pr,
    );
  }

  async createIssueComment(repo: string, issueNumber: number, body: string) {
    this.calls.push({ method: "createIssueComment", repo, issueNumber, body });
    if (this.failWritesWith) throw this.failWritesWith;
    this.putComment({
      id: 1000 + this.comments.length,
      issueNumber,
      body,
      updatedAt: new Date(
        Date.UTC(2026, 2, 1, 2, 0, this.comments.length),
      ).toISOString(),
    });
  }

  private toPullRequest(repo: string, pr: FakePullRequest): GitHubPullRequest {
    return {
      number: pr.number,
      url: `https://github.invalid/${repo}/pull/${pr.number}`,
    };
  }
}

export const VALID_FACTORY_YML = `
version: 1
level: A
commands:
  setup: example-setup
  test: example-test
  lint: example-lint
verify:
  unverified:
    - example of an unverifiable area
paths:
  protected:
    - docs/**
  forbidden:
    - generated/**
limits:
  max_parallel: 1
  max_attempts: 3
issues:
  allowed_authors:
    - example-login
`;
