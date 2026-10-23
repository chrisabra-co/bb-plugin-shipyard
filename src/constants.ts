// Constants and helpers the board UI shares with the server. No zod here,
// so the frontend bundle stays small.
import type { Task } from "./model";

export const COLUMNS = [
  "planning",
  "queue",
  "in_progress",
  "ai_review",
  "human_review",
  "done",
] as const;
export type ColumnId = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<ColumnId, string> = {
  planning: "Planning",
  queue: "Queue",
  in_progress: "In Progress",
  ai_review: "AI Review",
  human_review: "Human Review",
  done: "Done",
};

/**
 * Where the task's agent thread is in the pipeline. Only the "running"
 * phases react to the thread going idle; the others ignore it, so a person
 * can chat with the thread during review without moving the card.
 */
export const PHASES = [
  "idle",
  "queued",
  "triage",
  "implement",
  "validate",
  "revise",
  "pr",
  "merge_fix",
  "review",
  "done",
] as const;
export type Phase = (typeof PHASES)[number];
export const RUNNING_PHASES: ReadonlySet<Phase> = new Set([
  "triage",
  "implement",
  "validate",
  "revise",
  "pr",
  "merge_fix",
]);

export const REVIEW_REASONS = [
  "completed",
  "qa_rejected",
  "stopped",
  "errors",
  "pr_created",
  "merged",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** A short human label for where a task is, shown on its card. */
export function statusLabel(task: Task): string {
  switch (task.phase) {
    case "queued":
      return task.note ?? "Queued";
    case "triage":
      return "Triaging";
    case "implement":
      return task.triage?.needsPlan ? "Planning and implementing" : "Implementing";
    case "validate":
      return "Validating";
    case "revise":
      return "Applying requested changes";
    case "pr":
      return "Opening pull request";
    case "merge_fix":
      return "Resolving merge conflicts";
    case "done":
      return task.reviewReason === "merged" ? "Merged" : "Done";
    default:
      break;
  }
  switch (task.reviewReason) {
    case "completed":
      return "Ready for review";
    case "qa_rejected":
      return "Validation found problems";
    case "stopped":
      return "Stopped";
    case "errors":
      return "Failed";
    case "pr_created":
      return task.pullRequest?.number
        ? `PR #${task.pullRequest.number} open`
        : "PR open";
    case "merged":
      return "Merged";
    default:
      return task.column === "planning" ? "Not started" : "";
  }
}
