// Shared task model: zod schemas used at the RPC boundary and by the agent
// tools. app.tsx imports only types from here.
import { z } from "zod";
import { COLUMNS, PHASES, REVIEW_REASONS } from "./constants";

export * from "./constants";

export const columnSchema = z.enum(COLUMNS);


export const TIERS = ["light", "standard", "deep", "hardest"] as const;
export type Tier = (typeof TIERS)[number];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const SCOPES = ["trivial", "small", "medium", "large"] as const;

export const triageSchema = z.object({
  tier: z
    .enum(TIERS)
    .describe(
      "light: mechanical, no ambiguity. standard: clear-scope feature or known bug. deep: many modules, unclear cause, security, migrations. hardest: only the most ambiguous, long-running work.",
    ),
  effort: z.enum(EFFORTS),
  needsPlan: z
    .boolean()
    .describe(
      "true when the approach is uncertain or the change spans several files; false if the diff fits in one sentence",
    ),
  scope: z.enum(SCOPES),
  title: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("Sentence case, at most 8 words, no trailing period"),
  reasoning: z.string().trim().max(600),
  verification: z
    .array(z.string().trim().min(1).max(200))
    .max(8)
    .describe(
      "Commands that verify this change, found in the project (package.json scripts, Makefile, CI). Empty when none.",
    ),
});
export type TriageInput = z.infer<typeof triageSchema>;

export const triageResultSchema = triageSchema.extend({
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  source: z.enum(["auto", "fallback", "off"]),
});
export type Triage = z.infer<typeof triageResultSchema>;

export const reportSchema = z.object({
  status: z
    .enum(["passed", "failed", "partial"])
    .describe(
      "passed: works and checks pass. partial: some checks could not run. failed: something is still broken.",
    ),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe(
      "For the reviewer: what changed, how it was verified, assumptions and follow-ups",
    ),
  checks: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        command: z.string().trim().max(300).optional(),
        passed: z.boolean(),
        details: z.string().trim().max(600).optional(),
      }),
    )
    .max(20),
  findings: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor"]),
        description: z.string().trim().min(1).max(600),
        fixed: z.boolean(),
      }),
    )
    .max(30),
});
export type Report = z.infer<typeof reportSchema>;

export const pullRequestSchema = z.object({
  number: z.number().nullable(),
  url: z.string(),
  title: z.string().nullable(),
  attention: z.string().nullable(),
});
export type PullRequestInfo = z.infer<typeof pullRequestSchema>;

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  column: columnSchema,
  position: z.number(),
  phase: z.enum(PHASES),
  reviewReason: z.enum(REVIEW_REASONS).nullable(),
  error: z.string().nullable(),
  note: z.string().nullable(),
  threadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  branch: z.string().nullable(),
  triage: triageResultSchema.nullable(),
  report: reportSchema.nullable(),
  pullRequest: pullRequestSchema.nullable(),
  changedFiles: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskEventSchema = z.object({
  id: z.number(),
  at: z.number(),
  kind: z.enum(["info", "success", "warning", "error"]),
  message: z.string(),
});
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const lessonSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  text: z.string(),
  source: z.string(),
  createdAt: z.number(),
});
export type Lesson = z.infer<typeof lessonSchema>;

export const TASK_ACTIONS = [
  "start",
  "stop",
  "retry_validation",
  "discard",
  "create_pr",
  "refresh_pr",
  "merge",
  "resolve_conflicts",
  "done",
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

