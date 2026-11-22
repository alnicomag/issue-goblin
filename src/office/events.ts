import type { Db } from "./db.ts";

/** 段階0で事務局が記録するイベントの種類。 */
export type EventType =
  | "issue.created"
  | "issue.state_changed"
  | "issue.closed"
  | "issue.label_conflict"
  | "issue.commented"
  | "repo.config_invalid"
  | "repo.config_missing";

export interface NewEvent {
  readonly type: EventType;
  readonly repo: string | null;
  readonly issueNumber: number | null;
  readonly payload: Record<string, unknown>;
  /** UTCのISO 8601形式。 */
  readonly createdAt: string;
}

/** イベントを1件記録する。重複の判定は呼び出し側で行う。 */
export function insertEvent(db: Db, event: NewEvent): void {
  db.prepare(
    `INSERT INTO events (type, repo, issue_number, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    event.type,
    event.repo,
    event.issueNumber,
    JSON.stringify(event.payload),
    event.createdAt,
  );
}
