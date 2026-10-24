// SQLite persistence for tasks, their event log, and project lessons.
// better-sqlite3 is synchronous, which lets bb.agents.configure (also
// synchronous) read the board when it builds a thread's instructions.
import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  type ColumnId,
  type PlanMode,
  type SettingsOverrides,
  type StageSkills,
  settingsOverridesSchema,
  stageSkillsSchema,
  type Lesson,
  type Phase,
  type PullRequestInfo,
  type Report,
  type ReviewReason,
  type Task,
  type TaskEvent,
  type Signal,
  type Triage,
  RUNNING_PHASES,
  pullRequestSchema,
  reportSchema,
  signalSchema,
  triageResultSchema,
} from "./model";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    title_auto INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    column_id TEXT NOT NULL,
    position REAL NOT NULL,
    phase TEXT NOT NULL DEFAULT 'idle',
    review_reason TEXT,
    error TEXT,
    note TEXT,
    thread_id TEXT,
    environment_id TEXT,
    branch TEXT,
    triage TEXT,
    report TEXT,
    pr TEXT,
    changed_files TEXT,
    merge_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_board ON tasks(project_id, column_id, position)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tasks_thread ON tasks(thread_id) WHERE thread_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id)`,
  `CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lessons_project ON lessons(project_id, created_at)`,
  // v0.2: Ideas and Brainstorm replace Planning; validation is a stage of In Progress.
  `UPDATE tasks SET column_id = 'ideas' WHERE column_id = 'planning'`,
  `UPDATE tasks SET column_id = 'in_progress' WHERE column_id = 'ai_review'`,
  `ALTER TABLE tasks ADD COLUMN plan_mode TEXT NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE tasks ADD COLUMN stage_skills TEXT`,
  `ALTER TABLE tasks ADD COLUMN plan TEXT`,
  // One row per project; the row with project_id '*' holds the default stage skills.
  `CREATE TABLE IF NOT EXISTS project_settings (
    project_id TEXT PRIMARY KEY,
    overrides TEXT NOT NULL DEFAULT '{}',
    stage_skills TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`,
  // The furthest build stage a task's thread started, so a restart resumes there.
  `ALTER TABLE tasks ADD COLUMN reached TEXT`,
  `UPDATE tasks SET reached = 'implement' WHERE triage IS NOT NULL AND thread_id IS NOT NULL`,
  // The agent's shipyard_done signal for the current stage.
  `ALTER TABLE tasks ADD COLUMN signal TEXT`,
];

/** project_settings row that holds the default stage skills for every project. */
export const DEFAULTS_ROW = "*";

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  title_auto: number;
  description: string;
  column_id: string;
  position: number;
  phase: string;
  review_reason: string | null;
  error: string | null;
  note: string | null;
  thread_id: string | null;
  environment_id: string | null;
  branch: string | null;
  triage: string | null;
  report: string | null;
  pr: string | null;
  changed_files: string | null;
  plan_mode: string;
  stage_skills: string | null;
  plan: string | null;
  reached: string | null;
  signal: string | null;
  merge_attempts: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export type Reached = "plan" | "implement";

export interface StoredTask extends Task {
  titleAuto: boolean;
  mergeAttempts: number;
  reached: Reached | null;
}

function parseJson<T>(
  raw: string | null,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T | null {
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseFiles(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toTask(row: TaskRow): StoredTask {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    titleAuto: row.title_auto === 1,
    description: row.description,
    column: row.column_id as ColumnId,
    position: row.position,
    phase: row.phase as Phase,
    reviewReason: (row.review_reason as ReviewReason | null) ?? null,
    error: row.error,
    note: row.note,
    threadId: row.thread_id,
    environmentId: row.environment_id,
    branch: row.branch,
    triage: parseJson<Triage>(row.triage, triageResultSchema),
    report: parseJson<Report>(row.report, reportSchema),
    pullRequest: parseJson<PullRequestInfo>(row.pr, pullRequestSchema),
    changedFiles: parseFiles(row.changed_files),
    planMode: (row.plan_mode as PlanMode | null) ?? "auto",
    stageSkills: parseJson<StageSkills>(row.stage_skills, stageSkillsSchema) ?? {},
    plan: row.plan,
    reached: row.reached === "plan" || row.reached === "implement" ? row.reached : null,
    signal: parseJson<Signal>(row.signal, signalSchema),
    mergeAttempts: row.merge_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** Only the fields a caller may patch; JSON fields are serialized here. */
export interface TaskPatch {
  title?: string;
  titleAuto?: boolean;
  description?: string;
  column?: ColumnId;
  position?: number;
  phase?: Phase;
  reviewReason?: ReviewReason | null;
  error?: string | null;
  note?: string | null;
  threadId?: string | null;
  environmentId?: string | null;
  branch?: string | null;
  triage?: Triage | null;
  report?: Report | null;
  pullRequest?: PullRequestInfo | null;
  changedFiles?: string[];
  planMode?: PlanMode;
  stageSkills?: StageSkills;
  plan?: string | null;
  reached?: Reached | null;
  signal?: Signal | null;
  mergeAttempts?: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  title: "title",
  titleAuto: "title_auto",
  description: "description",
  column: "column_id",
  position: "position",
  phase: "phase",
  reviewReason: "review_reason",
  error: "error",
  note: "note",
  threadId: "thread_id",
  environmentId: "environment_id",
  branch: "branch",
  triage: "triage",
  report: "report",
  pullRequest: "pr",
  changedFiles: "changed_files",
  planMode: "plan_mode",
  stageSkills: "stage_skills",
  plan: "plan",
  reached: "reached",
  signal: "signal",
  mergeAttempts: "merge_attempts",
  startedAt: "started_at",
  completedAt: "completed_at",
};

const JSON_FIELDS = new Set<keyof TaskPatch>([
  "signal",
  "triage",
  "report",
  "pullRequest",
  "changedFiles",
  "stageSkills",
]);

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export class Store {
  constructor(private readonly db: Db) {}

  static open(bb: BbPluginApi): Store {
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    return new Store(db);
  }

  getTask(id: string): StoredTask | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  /** Accepts a full id or a unique prefix of one, as CLI users type them. */
  findTask(idOrPrefix: string): StoredTask | null {
    const exact = this.getTask(idOrPrefix);
    if (exact) return exact;
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE id LIKE ? ESCAPE '\\' LIMIT 2`)
      .all(`${idOrPrefix.replace(/[\\%_]/g, "\\$&")}%`) as TaskRow[];
    return rows.length === 1 && rows[0] ? toTask(rows[0]) : null;
  }

  taskByThread(threadId: string): StoredTask | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE thread_id = ?`)
      .get(threadId) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  listTasks(projectId: string): StoredTask[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tasks WHERE project_id = ? ORDER BY position ASC, created_at ASC`,
        )
        .all(projectId) as TaskRow[]
    ).map(toTask);
  }

  listTasksInPhases(phases: readonly Phase[]): StoredTask[] {
    if (phases.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT * FROM tasks WHERE phase IN (${phases.map(() => "?").join(",")}) ORDER BY position ASC`,
        )
        .all(...phases) as TaskRow[]
    ).map(toTask);
  }

  projectIdsWithQueue(): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT project_id FROM tasks WHERE phase = 'queued'`)
        .all() as { project_id: string }[]
    ).map((row) => row.project_id);
  }

  /** Position after the last card in a column. */
  endPosition(projectId: string, column: ColumnId): number {
    const row = this.db
      .prepare(
        `SELECT MAX(position) AS max FROM tasks WHERE project_id = ? AND column_id = ?`,
      )
      .get(projectId, column) as { max: number | null };
    return (row.max ?? 0) + 1;
  }

  insertTask(input: {
    projectId: string;
    title: string;
    titleAuto: boolean;
    description: string;
    column: ColumnId;
    planMode: PlanMode;
    stageSkills: StageSkills;
  }): StoredTask {
    const now = Date.now();
    const id = newId("sy");
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, title_auto, description, column_id, position, phase, plan_mode, stage_skills, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.title,
        input.titleAuto ? 1 : 0,
        input.description,
        input.column,
        this.endPosition(input.projectId, input.column),
        input.column === "queue" ? "queued" : "idle",
        input.planMode,
        JSON.stringify(input.stageSkills),
        now,
        now,
      );
    return this.getTask(id) as StoredTask;
  }

  updateTask(id: string, input: TaskPatch): StoredTask {
    // A note describes the current phase, so a new phase clears it. A
    // signal ends a stage, so starting a new stage clears it; it stays while
    // the task waits in review, so the board can show it.
    let patch: TaskPatch = input.phase !== undefined && !("note" in input) ? { ...input, note: null } : input;
    if (patch.phase !== undefined && RUNNING_PHASES.has(patch.phase) && !("signal" in patch)) {
      patch = { ...patch, signal: null };
    }
    const keys = (Object.keys(patch) as (keyof TaskPatch)[]).filter(
      (key) => patch[key] !== undefined,
    );
    if (keys.length > 0) {
      const values = keys.map((key) => {
        const value = patch[key];
        if (JSON_FIELDS.has(key)) return value === null ? null : JSON.stringify(value);
        if (typeof value === "boolean") return value ? 1 : 0;
        return value as string | number | null;
      });
      this.db
        .prepare(
          `UPDATE tasks SET ${keys.map((key) => `${PATCH_COLUMNS[key]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        )
        .run(...values, Date.now(), id);
    }
    const task = this.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    return task;
  }

  deleteTask(id: string): void {
    this.db.prepare(`DELETE FROM task_events WHERE task_id = ?`).run(id);
    this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  }

  addEvent(taskId: string, kind: TaskEvent["kind"], message: string): void {
    this.db
      .prepare(
        `INSERT INTO task_events (task_id, at, kind, message) VALUES (?, ?, ?, ?)`,
      )
      .run(taskId, Date.now(), kind, message.slice(0, 2000));
  }

  listEvents(taskId: string, limit = 200): TaskEvent[] {
    return (
      this.db
        .prepare(
          `SELECT id, at, kind, message FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(taskId, limit) as TaskEvent[]
    ).reverse();
  }

  /** A project's overrides and stage skills; DEFAULTS_ROW holds the default stage skills. */
  projectSettings(projectId: string): { overrides: SettingsOverrides; stageSkills: StageSkills } {
    const row = this.db
      .prepare(`SELECT overrides, stage_skills FROM project_settings WHERE project_id = ?`)
      .get(projectId) as { overrides: string; stage_skills: string } | undefined;
    return {
      overrides: parseJson<SettingsOverrides>(row?.overrides ?? null, settingsOverridesSchema) ?? {},
      stageSkills: parseJson<StageSkills>(row?.stage_skills ?? null, stageSkillsSchema) ?? {},
    };
  }

  saveProjectSettings(projectId: string, value: { overrides: SettingsOverrides; stageSkills: StageSkills }): void {
    this.db
      .prepare(
        `INSERT INTO project_settings (project_id, overrides, stage_skills, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET overrides = excluded.overrides, stage_skills = excluded.stage_skills, updated_at = excluded.updated_at`,
      )
      .run(projectId, JSON.stringify(value.overrides), JSON.stringify(value.stageSkills), Date.now());
  }

  listLessons(projectId: string): Lesson[] {
    return (
      this.db
        .prepare(
          `SELECT id, project_id, text, source, created_at FROM lessons WHERE project_id = ? ORDER BY created_at ASC`,
        )
        .all(projectId) as {
        id: string;
        project_id: string;
        text: string;
        source: string;
        created_at: number;
      }[]
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      text: row.text,
      source: row.source,
      createdAt: row.created_at,
    }));
  }

  addLesson(projectId: string, text: string, source: string): Lesson {
    const lesson: Lesson = {
      id: newId("ls"),
      projectId,
      text,
      source,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO lessons (id, project_id, text, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(lesson.id, projectId, text, source, lesson.createdAt);
    return lesson;
  }

  deleteLesson(id: string): boolean {
    return this.db.prepare(`DELETE FROM lessons WHERE id = ?`).run(id).changes > 0;
  }
}

/** Strip the internal fields before a task crosses the RPC boundary. */
export function publicTask(task: StoredTask): Task {
  const { titleAuto: _titleAuto, mergeAttempts: _mergeAttempts, reached: _reached, ...rest } = task;
  return rest;
}
