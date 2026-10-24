// Constants and helpers the board UI shares with the server. No zod here,
// so the frontend bundle stays small.
import type { Task } from "./model";

export const COLUMNS = [
  "ideas",
  "brainstorm",
  "queue",
  "in_progress",
  "human_review",
  "done",
] as const;
export type ColumnId = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<ColumnId, string> = {
  ideas: "Ideas",
  brainstorm: "Brainstorm",
  queue: "Queue",
  in_progress: "In Progress",
  human_review: "Human Review",
  done: "Done",
};

/**
 * Where the task's agent thread is in the pipeline. Only the "running"
 * phases react to the thread going idle; the others ignore it, so a person
 * can chat with the thread (brainstorm, review) without moving the card.
 */
export const PHASES = [
  "idle",
  "brainstorm",
  "queued",
  "triage",
  "plan",
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
  "plan",
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
  "plan_ready",
  "blocked",
  "needs_input",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** The stages a task can run; each one can load skills. */
export const STAGES = ["brainstorm", "triage", "plan", "implement", "validate", "revise", "pr"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  brainstorm: "Brainstorm",
  triage: "Triage",
  plan: "Plan",
  implement: "Build",
  validate: "Validate",
  revise: "Revise",
  pr: "Pull request",
};

export const STAGE_HINTS: Record<Stage, string> = {
  brainstorm: "You and the agent shape an idea into a spec in its thread.",
  triage: "A short turn picks the model, the effort, and whether to plan.",
  plan: "The agent explores the code and writes a plan before any change.",
  implement: "The agent makes the change, verifies it, and commits.",
  validate: "The agent runs the checks and reviews its own diff.",
  revise: "The agent applies the changes you requested.",
  pr: "The agent pushes the branch and opens a pull request.",
};

export const PLAN_MODES = ["auto", "always", "skip"] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

export const PLAN_MODE_LABELS: Record<PlanMode, string> = {
  auto: "Auto",
  always: "Always",
  skip: "Skip",
};

/** The four steps on a card's stage track. "implement" shows as Build. */
export const TRACK = ["triage", "plan", "implement", "validate"] as const;
export type TrackStep = (typeof TRACK)[number];

export function trackStep(task: Task): TrackStep | null {
  switch (task.phase) {
    case "triage":
      return "triage";
    case "plan":
      return "plan";
    case "implement":
    case "revise":
    case "merge_fix":
      return "implement";
    case "validate":
      return "validate";
    default:
      return null;
  }
}

/** A short human label for where a task is, shown on its card. */
export function statusLabel(task: Task): string {
  switch (task.phase) {
    case "idle":
      return task.threadId ? "Brainstormed" : "";
    case "brainstorm":
      return "Brainstorming";
    case "queued":
      return task.note ?? "Queued";
    case "triage":
      return "Triaging";
    case "plan":
      return "Planning";
    case "implement":
      return "Building";
    case "validate":
      return "Validating";
    case "revise":
      return task.reviewReason === "plan_ready" ? "Revising the plan" : "Applying requested changes";
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
    case "plan_ready":
      return "Plan ready for approval";
    case "blocked":
      return "Blocked";
    case "needs_input":
      return "Needs your input";
    case "qa_rejected":
      return "Validation found problems";
    case "stopped":
      return "Stopped";
    case "errors":
      return "Failed";
    case "pr_created":
      return task.pullRequest?.number ? `PR #${task.pullRequest.number} open` : "PR open";
    case "merged":
      return "Merged";
    default:
      return "";
  }
}

/** "claude-sonnet-5-5" → "Sonnet 5.5"; other ids are returned as they are. */
export function shortModelName(model: string | null): string | null {
  if (!model) return null;
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!match) return model;
  const family = match[1] ?? "";
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2]}${match[3] && match[3].length <= 2 ? `.${match[3]}` : ""}`;
}
