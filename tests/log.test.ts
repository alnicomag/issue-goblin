import { describe, expect, it } from "vitest";
import { createLogger, errorFields } from "../src/office/log.ts";

describe("構造化ログ", () => {
  it("1行1件のJSONで出す", () => {
    const lines: string[] = [];
    const log = createLogger({
      write: (line) => lines.push(line),
      clock: { now: () => new Date("2026-01-02T03:04:05.000Z") },
    });

    log.info("sync.done", { repo: "owner/name", issues: 2 });
    log.error("sync.failed", { error: "line1\nline2" });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.trimEnd()).not.toContain("\n");
    }
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: "2026-01-02T03:04:05.000Z",
      level: "info",
      event: "sync.done",
      repo: "owner/name",
      issues: 2,
    });
  });

  it("例外からは、メッセージと種類だけを取り出す", () => {
    const error = Object.assign(new Error("Bad credentials"), {
      status: 401,
      request: { headers: { authorization: "token SECRET-VALUE" } },
    });
    const fields = errorFields(error);
    expect(fields).toEqual({
      error: "Bad credentials",
      error_name: "Error",
      status: 401,
    });
    expect(JSON.stringify(fields)).not.toContain("SECRET-VALUE");
  });
});
