import type {
  GitHubApi,
  GitHubComment,
  GitHubFileResult,
  GitHubIssue,
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
    };

/** ネットワークに出ない、偽のGitHub。1つのリポジトリの内容をメモリに持つ。 */
export class FakeGitHub implements GitHubApi {
  issues: GitHubIssue[] = [];
  comments: GitHubComment[] = [];
  file: { sha: string; content: string } | null = null;
  /** 設定すると、すべての読み取りがこの例外で失敗する。 */
  failWith: Error | null = null;
  /** 設定すると、addLabels がこの例外で失敗する。 */
  failWritesWith: Error | null = null;
  readonly calls: Call[] = [];

  get writes(): Call[] {
    return this.calls.filter((call) => call.method === "addLabels");
  }

  /** イシューを追加、または同じ番号のものを置き換える。 */
  putIssue(
    issue: Partial<GitHubIssue> & { number: number; updatedAt: string },
  ) {
    const previous = this.issues.find((i) => i.number === issue.number);
    const next: GitHubIssue = {
      title: `Issue ${issue.number}`,
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
