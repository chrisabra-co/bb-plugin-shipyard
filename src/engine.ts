// The task pipeline. Each task owns one visible bb thread in its own git
// worktree. The engine sends that thread one prompt per stage and advances
// the card when the thread goes idle:
//
//   ideas → (brainstorm, with the user) → queue
//   queue → triage → (plan → (approval)) → implement → validate → human review
//   human review → (request changes) revise → validate → human review
//   human review → create PR → merge → done
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  type ColumnId,
  type DoneInput,
  type Effort,
  EFFORTS,
  type Phase,
  type PlanMode,
  type Report,
  RUNNING_PHASES,
  type ShipyardSettings,
  type Stage,
  type StageSkills,
  type TaskAction,
  type Tier,
  type Triage,
  type TriageInput,
} from "./model";
import {
  answerPrompt,
  brainstormPrompt,
  continuePrompt,
  implementPrompt,
  planPrompt,
  pullRequestPrompt,
  resolveConflictsPrompt,
  revisePlanPrompt,
  revisePrompt,
  triagePrompt,
  validatePrompt,
  withSkills,
} from "./prompts";
import type { Settings } from "./settings";
import { type StoredTask, type Store, type TaskPatch } from "./store";

export const BOARD_CHANGED = "board-changed";

/** Phases that hold one of the project's parallel slots. Brainstorm waits for a person, so it holds none. */
const SLOT_PHASES: readonly Phase[] = ["triage", "plan", "implement", "validate", "revise", "merge_fix"];

const TIER_FAMILIES: Record<Tier, string> = {
  light: "haiku",
  standard: "sonnet",
  deep: "opus",
  hardest: "fable",
};

/** The stage whose skills load when a stopped phase resumes. */
const STAGE_OF_PHASE: Partial<Record<Phase, Stage>> = {
  plan: "plan",
  implement: "implement",
  revise: "revise",
  validate: "validate",
  pr: "pr",
  merge_fix: "implement",
};

const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_PLAN_CHARS = 20_000;

type Sdk = BbPluginApi["sdk"];

interface ModelInfo {
  model: string;
  isDefault: boolean;
  efforts: string[];
  defaultEffort: string;
}

interface Execution {
  model?: string | null;
  reasoningLevel?: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string, max: number): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function fallbackTriage(task: StoredTask, source: "off" | "fallback", reasoning: string): Triage {
  return {
    tier: "standard",
    effort: "medium",
    needsPlan: false,
    scope: "medium",
    title: task.title,
    reasoning,
    verification: [],
    model: null,
    reasoningLevel: null,
    source,
  };
}

export class Engine {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly modelCache = new Map<string, { at: number; models: ModelInfo[] }>();
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: Store,
    private readonly settings: Settings,
  ) {}

  private get sdk(): Sdk {
    return this.bb.sdk;
  }

  /** Serialize work per task so events and user actions never interleave. */
  private withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.locks.set(taskId, next);
    void next.finally(() => {
      if (this.locks.get(taskId) === next) this.locks.delete(taskId);
    });
    return next;
  }

  changed(projectId: string | null): void {
    this.bb.realtime.publish(BOARD_CHANGED, { projectId });
  }

  private log(task: StoredTask, kind: "info" | "success" | "warning" | "error", message: string): void {
    this.store.addEvent(task.id, kind, message);
  }

  private settingsFor(task: StoredTask): ShipyardSettings {
    return this.settings.effective(task.projectId);
  }

  // ---------------------------------------------------------------------
  // User operations
  // ---------------------------------------------------------------------

  async createTask(input: {
    projectId: string;
    title?: string;
    description: string;
    destination: "ideas" | "brainstorm" | "queue";
    planMode?: PlanMode;
    stageSkills?: StageSkills;
  }): Promise<StoredTask> {
    const title = input.title?.trim() ?? "";
    const task = this.store.insertTask({
      projectId: input.projectId,
      title: title || firstLine(input.description, 80) || "Untitled task",
      titleAuto: title === "",
      description: input.description.trim(),
      column: input.destination === "queue" ? "queue" : "ideas",
      planMode: input.planMode ?? "auto",
      stageSkills: input.stageSkills ?? {},
    });
    this.log(task, "info", input.destination === "queue" ? "Created and queued" : "Created");
    this.changed(task.projectId);
    if (input.destination === "brainstorm") return this.moveTask(task.id, "brainstorm");
    if (input.destination === "queue") this.pump();
    return task;
  }

  async editTask(
    id: string,
    patch: { title?: string; description?: string; planMode?: PlanMode; stageSkills?: StageSkills },
  ): Promise<StoredTask> {
    return this.withLock(id, async () => {
      const task = this.requireTask(id);
      const title = patch.title?.trim();
      const updated = this.store.updateTask(id, {
        ...(title ? { title, titleAuto: false } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        ...(patch.planMode ? { planMode: patch.planMode } : {}),
        ...(patch.stageSkills ? { stageSkills: patch.stageSkills } : {}),
      });
      if (title && task.threadId) {
        await this.sdk.threads.update({ threadId: task.threadId, title }).catch(() => undefined);
      }
      this.changed(task.projectId);
      return updated;
    });
  }

  async deleteTask(id: string): Promise<void> {
    await this.withLock(id, async () => {
      const task = this.requireTask(id);
      if (task.threadId && RUNNING_PHASES.has(task.phase)) {
        await this.stopThread(task.threadId);
      }
      this.store.deleteTask(id);
      this.changed(task.projectId);
    });
    this.pump();
  }

  /**
   * Move a card. A move is also a command: moving forward makes the agent
   * pick the task up from that column, as in proactive-agent/workbench.
   */
  async moveTask(id: string, column: ColumnId, position?: number): Promise<StoredTask> {
    const result = await this.withLock(id, async () => {
      const task = this.requireTask(id);
      const pos = position ?? this.store.endPosition(task.projectId, column);
      if (task.column === column) {
        return this.store.updateTask(id, { position: pos });
      }
      switch (column) {
        case "ideas":
          await this.haltIfRunning(task, "Moved back to Ideas");
          return this.store.updateTask(id, {
            column,
            position: pos,
            phase: "idle",
            reviewReason: null,
            error: null,
          });
        case "brainstorm":
          await this.haltIfRunning(task, "Moved to Brainstorm");
          return this.startBrainstorm(this.store.updateTask(id, { position: pos }));
        case "queue":
          await this.haltIfRunning(task, "Moved to the queue");
          this.log(task, "info", "Queued");
          return this.store.updateTask(id, {
            column,
            position: pos,
            phase: "queued",
            reviewReason: null,
            error: null,
          });
        case "in_progress":
          await this.haltIfRunning(task, "Started from In Progress");
          this.store.updateTask(id, { position: pos });
          return this.begin(this.requireTask(id));
        case "human_review": {
          const wasRunning = await this.haltIfRunning(task, "Moved to Human Review");
          return this.store.updateTask(id, {
            column,
            position: pos,
            phase: "review",
            reviewReason: wasRunning ? "stopped" : task.reviewReason ?? (task.triage ? "completed" : null),
          });
        }
        case "done":
          await this.haltIfRunning(task, "Marked done");
          return this.finish(task, pos, task.reviewReason === "merged" ? "merged" : null);
      }
    });
    this.changed(result.projectId);
    this.pump();
    return result;
  }

  async runAction(id: string, action: TaskAction): Promise<StoredTask> {
    const result = await this.withLock(id, async () => {
      const task = this.requireTask(id);
      switch (action) {
        case "start":
          if (task.column === "ideas" || task.column === "brainstorm") {
            this.log(task, "info", "Queued");
            return this.store.updateTask(id, {
              column: "queue",
              position: this.store.endPosition(task.projectId, "queue"),
              phase: "queued",
              reviewReason: null,
              error: null,
            });
          }
          await this.haltIfRunning(task, "Restarted");
          return this.begin(this.requireTask(id));
        case "approve_plan":
          if (task.reviewReason !== "plan_ready" || task.column !== "human_review" || RUNNING_PHASES.has(task.phase)) {
            throw new Error("This task has no plan waiting for approval.");
          }
          this.log(task, "success", "Plan approved");
          return this.implement(task, { afterPlan: true });
        case "stop":
          if (!task.threadId || !RUNNING_PHASES.has(task.phase)) return task;
          await this.haltIfRunning(task, "Stopped by the user");
          return this.toHumanReview(this.requireTask(id), "stopped");
        case "retry_validation":
          if (!task.threadId) throw new Error("This task has no agent thread yet.");
          await this.haltIfRunning(task, "Validation restarted");
          return this.runValidation(this.requireTask(id));
        case "discard":
          return this.discard(task);
        case "create_pr":
          return this.createPullRequest(task);
        case "refresh_pr":
          return this.refreshPullRequest(task);
        case "merge":
          return this.merge(task);
        case "resolve_conflicts":
          return this.resolveConflicts(task, false);
        case "done":
          await this.haltIfRunning(task, "Marked done");
          return this.finish(task, this.store.endPosition(task.projectId, "done"), null);
      }
    });
    this.changed(result.projectId);
    this.pump();
    return result;
  }

  async requestChanges(id: string, feedback: string, startOver: boolean): Promise<StoredTask> {
    const result = await this.withLock(id, async () => {
      const task = this.requireTask(id);
      const text = feedback.trim();
      if (!text) throw new Error("Describe the changes you want.");
      if (task.column !== "human_review" || RUNNING_PHASES.has(task.phase)) {
        throw new Error("You can request changes only on a task in Human Review.");
      }
      if (!startOver && task.threadId && !task.triage) {
        throw new Error("This task has not run yet. Queue it instead.");
      }
      const answering = (task.reviewReason === "blocked" || task.reviewReason === "needs_input") && task.signal !== null;
      this.log(task, "info", `${answering ? "Answer sent" : "Changes requested"}: ${firstLine(text, 160)}`);
      if (startOver || !task.threadId) {
        // The notes go into the description so every stage of the new
        // attempt, triage included, sees them. The attempt waits for a slot.
        const reset = await this.discard(task);
        this.log(reset, "info", "Queued a new attempt");
        return this.store.updateTask(reset.id, {
          description: `${reset.description}\n\nNotes from a discarded attempt:\n${text}`.trim(),
          column: "queue",
          position: this.store.endPosition(reset.projectId, "queue"),
          phase: "queued",
        });
      }
      const settings = this.settingsFor(task);
      if ((task.reviewReason === "blocked" || task.reviewReason === "needs_input") && task.signal) {
        // Resume the stage that stopped, in the same session.
        const phase = task.signal.phase;
        const stage = STAGE_OF_PHASE[phase];
        const skills = stage ? this.settings.skillsFor(task, stage) : [];
        await this.send(task, withSkills(skills, answerPrompt(text)), settings);
        return this.store.updateTask(id, {
          column: "in_progress",
          position: this.store.endPosition(task.projectId, "in_progress"),
          phase,
          reviewReason: null,
          error: null,
        });
      }
      if (task.reviewReason === "plan_ready") {
        await this.send(task, withSkills(this.settings.skillsFor(task, "plan"), revisePlanPrompt(text)), settings);
        return this.store.updateTask(id, {
          column: "in_progress",
          position: this.store.endPosition(task.projectId, "in_progress"),
          phase: "plan",
          reviewReason: null,
          error: null,
        });
      }
      await this.send(task, withSkills(this.settings.skillsFor(task, "revise"), revisePrompt(text, task.triage)), settings);
      return this.store.updateTask(id, {
        column: "in_progress",
        position: this.store.endPosition(task.projectId, "in_progress"),
        phase: "revise",
        reviewReason: null,
        report: null,
        error: null,
        mergeAttempts: 0,
      });
    });
    this.changed(result.projectId);
    return result;
  }

  addLesson(projectId: string, text: string, source: string) {
    const lesson = this.store.addLesson(projectId, text.trim(), source);
    this.changed(projectId);
    return lesson;
  }

  // ---------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------

  /** Start queued tasks while their project has free slots. Coalesces calls. */
  pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = (async () => {
      do {
        this.pumpAgain = false;
        try {
          await this.pumpOnce();
        } catch (error) {
          this.bb.log.error(`queue pump failed: ${errorMessage(error)}`);
        }
      } while (this.pumpAgain);
    })().finally(() => {
      this.pumping = null;
      if (this.pumpAgain) this.pump();
    });
  }

  private async pumpOnce(): Promise<void> {
    for (const projectId of this.store.projectIdsWithQueue()) {
      const { maxParallel } = this.settings.effective(projectId);
      const queued = this.store
        .listTasks(projectId)
        .filter((task) => task.phase === "queued" && task.column === "queue")
        .sort((a, b) => a.position - b.position);
      for (const task of queued) {
        // Count again each time: a start can fail, and "Run now" can take a slot.
        const running = this.store
          .listTasks(projectId)
          .filter((other) => SLOT_PHASES.includes(other.phase)).length;
        if (running >= maxParallel) {
          const note = `Waiting for a free slot (${running} of ${maxParallel} running)`;
          if (task.note !== note) {
            this.store.updateTask(task.id, { note });
            this.changed(projectId);
          }
          continue;
        }
        await this.withLock(task.id, async () => {
          const fresh = this.store.getTask(task.id);
          if (fresh?.phase !== "queued") return;
          await this.begin(fresh);
        });
        this.changed(projectId);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Pipeline steps
  // ---------------------------------------------------------------------

  /** Open the brainstorm in the task's thread; a new thread when it has none. */
  private async startBrainstorm(task: StoredTask): Promise<StoredTask> {
    const settings = this.settingsFor(task);
    const prompt = withSkills(
      this.settings.skillsFor(task, "brainstorm"),
      brainstormPrompt(task, { revisit: task.threadId !== null }),
    );
    try {
      const spawned = await this.dispatch(task, settings, prompt);
      this.log(task, "info", "Brainstorm started");
      return this.store.updateTask(task.id, {
        ...spawned,
        column: "brainstorm",
        phase: "brainstorm",
        reviewReason: null,
        error: null,
        triage: null,
        plan: null,
        report: null,
        reached: null,
      });
    } catch (error) {
      this.log(task, "error", `Could not start the brainstorm: ${errorMessage(error)}`);
      return this.store.updateTask(task.id, { column: "ideas", phase: "idle", error: errorMessage(error) });
    }
  }

  /** Start a task: triage, or the first build stage when triage is off. */
  private async begin(task: StoredTask): Promise<StoredTask> {
    const settings = this.settingsFor(task);
    const base: TaskPatch = {
      column: "in_progress",
      position: this.store.endPosition(task.projectId, "in_progress"),
      reviewReason: null,
      error: null,
      startedAt: task.startedAt ?? Date.now(),
    };
    try {
      // A task with a triage resumes in its thread from the furthest stage it started.
      if (task.threadId && task.triage) {
        if (task.reached === "implement") {
          await this.send(task, withSkills(this.settings.skillsFor(task, "implement"), continuePrompt(task)), settings);
          this.log(task, "info", "Continuing in the existing thread");
          return this.store.updateTask(task.id, { ...base, phase: "implement" });
        }
        if (task.reached === "plan" && task.plan) {
          if (settings.planApproval) {
            this.log(task, "info", "The plan still waits for your approval");
            return this.toHumanReview(task, "plan_ready");
          }
          return this.implement(this.store.updateTask(task.id, base), { afterPlan: true });
        }
        return this.startBuild(this.store.updateTask(task.id, base));
      }
      if (settings.triage) {
        const providerId = await this.threadProvider(task, settings);
        const models = providerId ? await this.models(task.projectId, providerId) : [];
        const triageModel = this.pickModel(models, providerId, "light");
        const spawned = await this.dispatch(
          task,
          settings,
          withSkills(this.settings.skillsFor(task, "triage"), triagePrompt(task, settings.allowHardest)),
          {
            model: triageModel?.model,
            reasoningLevel: triageModel ? this.pickEffort(triageModel, "low") : undefined,
          },
          providerId,
        );
        this.log(task, "info", "Triage started");
        return this.store.updateTask(task.id, {
          ...base,
          ...spawned,
          phase: "triage",
          triage: null,
          report: null,
          plan: null,
          reached: null,
        });
      }
      const withTriage = this.store.updateTask(task.id, {
        ...base,
        triage: fallbackTriage(task, "off", "Triage is off; the provider's default model runs the task."),
        report: null,
        plan: null,
        reached: null,
      });
      return this.startBuild(withTriage);
    } catch (error) {
      this.log(task, "error", `Could not start: ${errorMessage(error)}`);
      return this.toHumanReview(task, "errors", { error: errorMessage(error) });
    }
  }

  /** Whether this task plans first: the task's choice, then the setting, then triage. */
  private needsPlan(task: StoredTask, settings: ShipyardSettings): boolean {
    if (task.planMode === "always") return true;
    if (task.planMode === "skip") return false;
    if (settings.planning === "always") return true;
    if (settings.planning === "never") return false;
    return task.triage?.needsPlan ?? false;
  }

  /** After triage: plan first, or implement. */
  private async startBuild(task: StoredTask): Promise<StoredTask> {
    const settings = this.settingsFor(task);
    if (!this.needsPlan(task, settings)) return this.implement(task, { afterPlan: false });
    const spawned = await this.dispatch(
      task,
      settings,
      withSkills(
        this.settings.skillsFor(task, "plan"),
        planPrompt(task, { includeTask: task.threadId === null, commitPlans: settings.commitPlans }),
      ),
      this.executionFor(task),
    );
    this.log(task, "info", "Planning started");
    return this.store.updateTask(task.id, {
      ...spawned,
      column: "in_progress",
      phase: "plan",
      reviewReason: null,
      plan: null,
      reached: "plan",
    });
  }

  private async implement(task: StoredTask, opts: { afterPlan: boolean }): Promise<StoredTask> {
    const settings = this.settingsFor(task);
    const spawned = await this.dispatch(
      task,
      settings,
      withSkills(
        this.settings.skillsFor(task, "implement"),
        implementPrompt(task, {
          includeTask: task.threadId === null,
          afterPlan: opts.afterPlan,
          commitPlans: settings.commitPlans,
        }),
      ),
      this.executionFor(task),
    );
    this.log(task, "info", "Build started");
    return this.store.updateTask(task.id, {
      ...spawned,
      column: "in_progress",
      position: task.column === "in_progress" ? task.position : this.store.endPosition(task.projectId, "in_progress"),
      phase: "implement",
      reviewReason: null,
      report: null,
      reached: "implement",
    });
  }

  private executionFor(task: StoredTask): Execution {
    return { model: task.triage?.model, reasoningLevel: task.triage?.reasoningLevel };
  }

  /**
   * Send a prompt to the task's thread, or spawn the thread with it. Returns
   * the fields to store when it spawned one.
   */
  private async dispatch(
    task: StoredTask,
    settings: ShipyardSettings,
    prompt: string,
    execution: Execution = {},
    providerId?: string | null,
  ): Promise<TaskPatch> {
    if (task.threadId) {
      await this.send(task, prompt, settings, execution);
      return {};
    }
    const hostId = await this.projectHost(task.projectId);
    const provider = providerId === undefined ? await this.resolveProvider(task.projectId, settings) : providerId;
    const thread = await this.sdk.threads.spawn({
      projectId: task.projectId,
      title: task.title,
      environment: {
        type: "host",
        hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: settings.baseBranch ? { kind: "named", name: settings.baseBranch } : { kind: "default" },
        },
      },
      prompt,
      permissionMode: settings.permissionMode,
      ...(provider ? { providerId: provider } : {}),
      ...(execution.model ? { model: execution.model } : {}),
      ...(execution.reasoningLevel ? { reasoningLevel: execution.reasoningLevel } : {}),
      pluginMetadata: { taskId: task.id },
    });
    return { threadId: thread.id, environmentId: thread.environmentId };
  }

  private async send(task: StoredTask, text: string, settings: ShipyardSettings, execution: Execution = {}): Promise<void> {
    if (!task.threadId) throw new Error("This task has no agent thread.");
    const thread = await this.sdk.threads.get({ threadId: task.threadId });
    if (thread.archivedAt !== null) {
      await this.sdk.threads.unarchive({ threadId: task.threadId });
    }
    await this.sdk.threads.send({
      threadId: task.threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
      permissionMode: settings.permissionMode,
      ...(execution.model ? { model: execution.model } : {}),
      ...(execution.reasoningLevel ? { reasoningLevel: execution.reasoningLevel } : {}),
    });
  }

  private async runValidation(task: StoredTask): Promise<StoredTask> {
    const settings = this.settingsFor(task);
    const baseBranch = await this.baseBranchFor(task, settings);
    await this.send(task, withSkills(this.settings.skillsFor(task, "validate"), validatePrompt(task, baseBranch)), settings);
    this.log(task, "info", "Validation started");
    return this.store.updateTask(task.id, {
      column: "in_progress",
      position: task.column === "in_progress" ? task.position : this.store.endPosition(task.projectId, "in_progress"),
      phase: "validate",
      reviewReason: null,
      report: null,
      error: null,
    });
  }

  private toHumanReview(
    task: StoredTask,
    reason: "completed" | "qa_rejected" | "errors" | "stopped" | "plan_ready" | "blocked" | "needs_input",
    extra: { error?: string | null } = {},
  ): StoredTask {
    return this.store.updateTask(task.id, {
      column: "human_review",
      position: this.store.endPosition(task.projectId, "human_review"),
      phase: "review",
      reviewReason: reason,
      ...extra,
    });
  }

  private async finish(task: StoredTask, position: number, reason: "merged" | null): Promise<StoredTask> {
    const settings = this.settingsFor(task);
    if (settings.archiveOnDone && task.threadId) {
      await this.sdk.threads.archive({ threadId: task.threadId }).catch((error: unknown) => {
        this.log(task, "warning", `Could not archive the thread: ${errorMessage(error)}`);
      });
    }
    this.log(task, "success", reason === "merged" ? "Merged" : "Done");
    return this.store.updateTask(task.id, {
      column: "done",
      position,
      phase: "done",
      // A plan that waited for approval is no longer pending once the task is done.
      reviewReason: reason ?? (task.reviewReason === "plan_ready" ? null : task.reviewReason),
      completedAt: Date.now(),
    });
  }

  private async discard(task: StoredTask): Promise<StoredTask> {
    if (task.threadId) {
      // Clear the phase first so the stopped thread's events are ignored.
      this.store.updateTask(task.id, { phase: "idle" });
      await this.stopThread(task.threadId);
      await this.sdk.threads.archive({ threadId: task.threadId }).catch(() => undefined);
    }
    this.log(task, "warning", "Attempt discarded");
    return this.store.updateTask(task.id, {
      column: "ideas",
      position: this.store.endPosition(task.projectId, "ideas"),
      phase: "idle",
      reviewReason: null,
      error: null,
      threadId: null,
      environmentId: null,
      branch: null,
      triage: null,
      report: null,
      plan: null,
      reached: null,
      pullRequest: null,
      changedFiles: [],
      mergeAttempts: 0,
      startedAt: null,
      completedAt: null,
    });
  }

  private async createPullRequest(task: StoredTask): Promise<StoredTask> {
    if (!task.threadId) throw new Error("Start the task before you open a pull request.");
    const settings = this.settingsFor(task);
    const existing = await this.fetchPullRequest(task);
    if (existing) {
      return this.store.updateTask(task.id, {
        pullRequest: existing,
        reviewReason: "pr_created",
        error: null,
        mergeAttempts: 0,
      });
    }
    await this.send(
      task,
      withSkills(this.settings.skillsFor(task, "pr"), pullRequestPrompt(task, await this.baseBranchFor(task, settings))),
      settings,
    );
    this.log(task, "info", "Asked the agent to open a pull request");
    return this.store.updateTask(task.id, { phase: "pr", error: null, mergeAttempts: 0 });
  }

  private async refreshPullRequest(task: StoredTask): Promise<StoredTask> {
    const pr = await this.fetchPullRequest(task);
    if (!pr) return task;
    if (pr.attention === "merged") {
      return this.finish(
        this.store.updateTask(task.id, { pullRequest: pr }),
        this.store.endPosition(task.projectId, "done"),
        "merged",
      );
    }
    return this.store.updateTask(task.id, { pullRequest: pr, reviewReason: "pr_created", error: null });
  }

  private async merge(task: StoredTask): Promise<StoredTask> {
    if (!task.environmentId) throw new Error("This task has no workspace to merge.");
    const settings = this.settingsFor(task);
    const pr = await this.fetchPullRequest(task);
    if (!pr) throw new Error("Open a pull request first.");
    try {
      await this.sdk.environments.mergePullRequest({
        environmentId: task.environmentId,
        method: settings.mergeMethod,
      });
    } catch (error) {
      const message = errorMessage(error);
      this.log(task, "error", `Merge failed: ${message}`);
      if (pr.attention === "conflicts" && task.mergeAttempts < 1) {
        return this.resolveConflicts(task, true);
      }
      return this.store.updateTask(task.id, { pullRequest: pr, error: `Merge failed: ${message}` });
    }
    return this.finish(
      this.store.updateTask(task.id, { pullRequest: { ...pr, attention: "merged" }, error: null }),
      this.store.endPosition(task.projectId, "done"),
      "merged",
    );
  }

  /** Ask the agent to merge the base branch in; with retry, merge again after. */
  private async resolveConflicts(task: StoredTask, retryMerge: boolean): Promise<StoredTask> {
    const settings = this.settingsFor(task);
    await this.send(task, resolveConflictsPrompt(await this.baseBranchFor(task, settings), task.triage), settings);
    this.log(task, "info", "Asked the agent to resolve merge conflicts");
    return this.store.updateTask(task.id, {
      phase: "merge_fix",
      note: retryMerge ? "Will merge again after the conflicts are resolved" : null,
      error: null,
      mergeAttempts: task.mergeAttempts + 1,
    });
  }

  // ---------------------------------------------------------------------
  // Agent tool callbacks
  // ---------------------------------------------------------------------

  /**
   * The thread id is stored right after threads.spawn returns, so a very
   * early tool call can arrive first. Wait briefly for it.
   */
  private async taskForTool(threadId: string): Promise<StoredTask | null> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const task = this.store.taskByThread(threadId);
      if (task) return task;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return null;
  }

  // The tool callbacks take no task lock: a lock holder may be stopping this
  // very thread, and the stop may wait for the tool call to finish.
  async recordTriage(threadId: string, input: TriageInput): Promise<string> {
    const task = await this.taskForTool(threadId);
    if (!task) return "This thread is not a Shipyard task. Nothing was recorded.";
    if (task.phase !== "triage") return "Shipyard records a triage only during the triage stage. Nothing was recorded.";
    const settings = this.settingsFor(task);
    const tier: Tier = !settings.allowHardest && input.tier === "hardest" ? "deep" : input.tier;
    const providerId = await this.threadProvider(task, settings);
    const models = providerId ? await this.models(task.projectId, providerId) : [];
    const model = this.pickModel(models, providerId, tier);
    const triage: Triage = {
      ...input,
      tier,
      model: model?.model ?? null,
      reasoningLevel: (model ? this.pickEffort(model, input.effort) : null) ?? null,
      source: "auto",
    };
    const patch: TaskPatch = { triage };
    if (task.titleAuto && input.title) {
      patch.title = input.title;
      await this.sdk.threads.update({ threadId, title: input.title }).catch(() => undefined);
    }
    const updated = this.store.updateTask(task.id, patch);
    this.log(
      task,
      "info",
      `Triage: ${tier}${triage.model ? ` (${triage.model})` : ""}, ${input.effort} effort, ${this.needsPlan(updated, settings) ? "plan first" : "no plan"}. ${input.reasoning}`,
    );
    this.changed(task.projectId);
    return "Triage recorded. Stop now; Shipyard starts the next stage.";
  }

  async recordReport(threadId: string, report: Report): Promise<string> {
    const task = await this.taskForTool(threadId);
    if (!task) return "This thread is not a Shipyard task. Nothing was recorded.";
    this.store.updateTask(task.id, { report });
    this.log(
      task,
      report.status === "failed" ? "error" : report.status === "partial" ? "warning" : "success",
      `Validation ${report.status}: ${firstLine(report.summary, 200)}`,
    );
    this.changed(task.projectId);
    return "Report recorded. Stop now; the task goes to human review.";
  }

  async recordSpec(threadId: string, input: { title?: string; spec: string }): Promise<string> {
    const task = await this.taskForTool(threadId);
    if (!task) return "This thread is not a Shipyard task. Nothing was recorded.";
    if (task.phase !== "brainstorm") return "The spec can change only while the task is in Brainstorm.";
    const title = input.title?.trim();
    this.store.updateTask(task.id, {
      description: input.spec.trim(),
      ...(title ? { title, titleAuto: false } : {}),
    });
    if (title) await this.sdk.threads.update({ threadId, title }).catch(() => undefined);
    this.log(task, "success", `Spec saved. The earlier description was: ${firstLine(task.description || task.title, 300)}`);
    this.changed(task.projectId);
    return 'Spec saved on the card. Tell the user to choose "Queue it" or "Save for later".';
  }

  async recordDone(threadId: string, input: DoneInput): Promise<string> {
    const task = await this.taskForTool(threadId);
    if (!task) return "This thread is not a Shipyard task. Nothing was recorded.";
    if (!RUNNING_PHASES.has(task.phase) || task.phase === "triage") {
      return "No Shipyard build stage is running in this thread. Nothing was recorded.";
    }
    this.store.updateTask(task.id, { signal: { ...input, phase: task.phase, at: Date.now() } });
    this.log(
      task,
      input.status === "done" ? "info" : "warning",
      `${input.status === "done" ? "Stage done" : input.status === "blocked" ? "Blocked" : "Needs input"}: ${firstLine(input.summary, 200)}`,
    );
    this.changed(task.projectId);
    return input.status === "done"
      ? "Recorded. End your turn now; Shipyard starts the next stage."
      : "Recorded. End your turn now; the task waits for the user's answer.";
  }

  async recordLesson(threadId: string, text: string): Promise<string> {
    const task = this.store.taskByThread(threadId);
    if (!task) return "This thread is not a Shipyard task. Use `bb shipyard learn` instead.";
    this.addLesson(task.projectId, text, `task ${task.id}`);
    return "Lesson recorded. Later tasks in this project will see it.";
  }

  // ---------------------------------------------------------------------
  // Thread events
  // ---------------------------------------------------------------------

  /** The task this thread runs, if it still owns it and is in a running phase. */
  private ownedRunningTask(taskId: string, threadId: string): StoredTask | null {
    const task = this.store.getTask(taskId);
    return task && task.threadId === threadId && RUNNING_PHASES.has(task.phase) ? task : null;
  }

  async onThreadIdle(threadId: string): Promise<void> {
    const task = this.store.taskByThread(threadId);
    if (!task || !RUNNING_PHASES.has(task.phase)) return;
    await this.withLock(task.id, async () => {
      if (!this.ownedRunningTask(task.id, threadId)) return;
      // An idle can come from an earlier turn (one a stop cut short, or the
      // user's own chat) while the phase's prompt still waits in the queue.
      // Only a thread that is idle with nothing queued finished the phase.
      const thread = await this.sdk.threads.get({ threadId }).catch(() => null);
      if (!thread || thread.status !== "idle" || thread.queuedMessageCount > 0) return;
      await this.advance(task.id);
    });
    this.changed(task.projectId);
    this.pump();
  }

  private async advance(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || !RUNNING_PHASES.has(task.phase) || !task.threadId) return;
    const settings = this.settingsFor(task);
    await this.refreshWorkspace(task);
    const current = this.requireTask(taskId);
    // The agent's own signal decides whether the stage ended; idle alone is
    // the fallback for an agent that did not call shipyard_done.
    const signal = current.signal?.phase === current.phase ? current.signal : null;
    if (signal && signal.status !== "done") {
      this.toHumanReview(current, signal.status);
      return;
    }
    if (!signal && current.phase !== "triage" && current.phase !== "validate") {
      this.log(current, "info", "The agent ended the stage without shipyard_done; Shipyard treats it as done");
    }
    try {
      switch (current.phase) {
        case "triage": {
          let ready = current;
          if (!current.triage) {
            this.log(current, "warning", "Triage gave no decision; using the defaults");
            ready = this.store.updateTask(taskId, {
              triage: fallbackTriage(current, "fallback", "Fallback: the triage turn did not call shipyard_triage."),
            });
          }
          await this.startBuild(ready);
          return;
        }
        case "plan": {
          const output = await this.sdk.threads.output({ threadId: current.threadId as string }).catch(() => null);
          const plan = output?.output?.trim().slice(0, MAX_PLAN_CHARS) || null;
          const withPlan = this.store.updateTask(taskId, { plan });
          if (!plan) this.log(current, "warning", "The plan turn gave no text");
          if (settings.planApproval) {
            this.log(current, "info", "Plan ready for approval");
            this.toHumanReview(withPlan, "plan_ready", {
              error: plan ? null : "The plan turn gave no text. Open the thread to read the plan, or ask for changes.",
            });
            return;
          }
          await this.implement(withPlan, { afterPlan: true });
          return;
        }
        case "implement":
        case "revise":
          if (settings.validation) {
            await this.runValidation(current);
          } else {
            this.log(current, "success", "Ready for review");
            this.toHumanReview(current, "completed");
          }
          return;
        case "validate": {
          const report = current.report;
          if (!report) this.log(current, "warning", "Validation gave no report");
          this.toHumanReview(current, report?.status === "failed" ? "qa_rejected" : "completed");
          return;
        }
        case "pr": {
          // bb's lookup can lag a moment behind `gh pr create`.
          let pr = await this.fetchPullRequest(current);
          for (let attempt = 0; !pr && attempt < 3; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            pr = await this.fetchPullRequest(current);
          }
          if (pr) {
            this.log(current, "success", `Pull request opened: ${pr.url}`);
            this.store.updateTask(taskId, { phase: "review", reviewReason: "pr_created", pullRequest: pr, error: null });
          } else {
            this.log(current, "warning", "No pull request found for this branch");
            this.store.updateTask(taskId, {
              phase: "review",
              error: "The agent finished, but bb found no pull request for this branch.",
            });
          }
          return;
        }
        case "merge_fix": {
          const retry = current.note?.startsWith("Will merge again") ?? false;
          const resolved = this.store.updateTask(taskId, { phase: "review", note: null });
          if (retry) {
            // Give GitHub a moment to recompute mergeability after the push.
            await new Promise((resolve) => setTimeout(resolve, 5000));
            await this.merge(resolved);
          }
          return;
        }
        default:
          return;
      }
    } catch (error) {
      this.log(current, "error", errorMessage(error));
      this.toHumanReview(current, "errors", { error: errorMessage(error) });
    }
  }

  /** Rate limits retry on the provider's reset time; other failures stop. */
  async onTurnFailed(event: {
    threadId: string;
    requestId: string;
    errorInfo: { category?: string; message?: string } | null;
    rateLimits: { windows: { resetsAtMs: number | null }[] } | null;
    attemptNumber: number;
  }): Promise<void> {
    const task = this.store.taskByThread(event.threadId);
    if (!task || !RUNNING_PHASES.has(task.phase)) return;
    await this.withLock(task.id, async () => {
      const fresh = this.ownedRunningTask(task.id, event.threadId);
      if (!fresh) return;
      if (event.errorInfo?.category === "rate-limit" && event.attemptNumber < MAX_RATE_LIMIT_RETRIES) {
        const resetsAt = event.rateLimits?.windows.find((window) => window.resetsAtMs !== null)?.resetsAtMs ?? null;
        await this.sdk.threads.retry({
          threadId: event.threadId,
          turnRequestId: event.requestId,
          ...(resetsAt === null ? {} : { sendAt: resetsAt + 15_000 }),
          reason: "Shipyard: rate limited",
        });
        const when = resetsAt ? new Date(resetsAt).toLocaleTimeString() : "soon";
        this.log(fresh, "warning", `Rate limited; retrying ${resetsAt ? `at ${when}` : "now"}`);
        this.store.updateTask(fresh.id, { note: `Rate limited; resumes ${resetsAt ? `at ${when}` : "soon"}` });
        return;
      }
      const message = event.errorInfo?.message ?? "The agent turn failed.";
      this.log(fresh, "error", message);
      this.toHumanReview(fresh, "errors", { error: message });
    });
    this.changed(task.projectId);
    this.pump();
  }

  /**
   * A thread can fail outside a turn (for example, its worktree could not be
   * created). turn.failed may arrive for the same failure and schedule a
   * rate-limit retry, so wait briefly and check again before giving up.
   */
  async onThreadFailed(threadId: string, error: string | null): Promise<void> {
    const task = this.store.taskByThread(threadId);
    if (!task || !RUNNING_PHASES.has(task.phase)) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await this.withLock(task.id, async () => {
      const fresh = this.ownedRunningTask(task.id, threadId);
      if (!fresh) return;
      const thread = await this.sdk.threads.get({ threadId }).catch(() => null);
      // A queued message means a retry is pending (for example, a rate limit).
      if (thread && (thread.status !== "error" || thread.queuedMessageCount > 0)) return;
      const message = error ?? "The agent thread failed.";
      this.log(fresh, "error", message);
      this.toHumanReview(fresh, "errors", { error: message });
    });
    this.changed(task.projectId);
    this.pump();
  }

  // ---------------------------------------------------------------------
  // Startup reconciliation
  // ---------------------------------------------------------------------

  /** Catch up on thread changes missed while the plugin was not loaded. */
  async reconcile(): Promise<void> {
    for (const task of this.store.listTasksInPhases([...RUNNING_PHASES])) {
      if (!task.threadId) continue;
      try {
        const thread = await this.sdk.threads.get({ threadId: task.threadId });
        if (thread.status === "idle") await this.onThreadIdle(task.threadId);
        else if (thread.status === "error" && thread.queuedMessageCount === 0) {
          await this.withLock(task.id, async () => {
            const fresh = this.ownedRunningTask(task.id, thread.id);
            if (!fresh) return;
            this.toHumanReview(fresh, "errors", { error: "The agent thread stopped with an error." });
          });
          this.changed(task.projectId);
        }
      } catch (error) {
        const message = errorMessage(error);
        this.bb.log.warn(`reconcile ${task.id}: ${message}`);
        // A deleted thread would hold its slot for good.
        if (/\b404\b|not found/i.test(message)) {
          await this.withLock(task.id, async () => {
            const fresh = this.ownedRunningTask(task.id, task.threadId as string);
            if (!fresh) return;
            this.toHumanReview(fresh, "errors", { error: "The task's thread no longer exists. Discard the attempt to start again." });
          });
          this.changed(task.projectId);
        }
      }
    }
    this.pump();
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private requireTask(id: string): StoredTask {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    return task;
  }

  private async stopThread(threadId: string): Promise<void> {
    await this.sdk.threads.stop({ threadId }).catch((error: unknown) => {
      this.bb.log.warn(`stop ${threadId}: ${errorMessage(error)}`);
    });
  }

  /** Stops the agent if it runs a phase. The phase is cleared first so the idle event that follows is ignored. */
  private async haltIfRunning(task: StoredTask, reason: string): Promise<boolean> {
    if (!task.threadId || !RUNNING_PHASES.has(task.phase)) return false;
    this.store.updateTask(task.id, { phase: "review" });
    await this.stopThread(task.threadId);
    this.log(task, "warning", reason);
    return true;
  }

  /** Record the worktree, branch, and changed files after each turn. */
  private async refreshWorkspace(task: StoredTask): Promise<void> {
    if (!task.threadId) return;
    try {
      const thread = await this.sdk.threads.get({ threadId: task.threadId });
      const environmentId = thread.environmentId ?? task.environmentId;
      if (!environmentId) return;
      const environment = await this.sdk.environments.get({ environmentId });
      const base = environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch;
      let changedFiles = task.changedFiles;
      if (base) {
        const diff = await this.sdk.environments.diffFiles({ environmentId, target: "all", mergeBaseBranch: base });
        if (diff.outcome === "available") {
          changedFiles = diff.files.map((file) => file.path).slice(0, 200);
        }
      }
      this.store.updateTask(task.id, { environmentId, branch: environment.branchName, changedFiles });
    } catch (error) {
      this.bb.log.warn(`workspace refresh ${task.id}: ${errorMessage(error)}`);
    }
  }

  private async baseBranchFor(task: StoredTask, settings: ShipyardSettings): Promise<string> {
    if (task.environmentId) {
      try {
        const environment = await this.sdk.environments.get({ environmentId: task.environmentId });
        const base = environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch;
        if (base) return base;
      } catch {
        // fall through to the setting
      }
    }
    return settings.baseBranch || "main";
  }

  private async fetchPullRequest(task: StoredTask) {
    if (!task.environmentId) return null;
    try {
      const result = await this.sdk.environments.pullRequest({ environmentId: task.environmentId });
      if (result.outcome !== "available") return null;
      const pr = result.pullRequest;
      return { number: pr.number, url: pr.url, title: pr.title, attention: pr.attention };
    } catch (error) {
      this.bb.log.warn(`pull request lookup ${task.id}: ${errorMessage(error)}`);
      return null;
    }
  }

  /** The machine of the project's default source; worktrees are created there. */
  async projectHost(projectId: string): Promise<string> {
    const project = await this.sdk.projects.get({ projectId });
    const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
    if (!source) throw new Error("This project has no source checkout to create a worktree from.");
    return source.hostId;
  }

  async resolveProvider(projectId: string, settings: ShipyardSettings): Promise<string | null> {
    if (settings.providerId) return settings.providerId;
    try {
      const defaults = await this.sdk.projects.defaultExecutionOptions({ projectId });
      return defaults?.providerId ?? null;
    } catch {
      return null;
    }
  }

  private async threadProvider(task: StoredTask, settings: ShipyardSettings): Promise<string | null> {
    if (task.threadId) {
      try {
        return (await this.sdk.threads.get({ threadId: task.threadId })).providerId;
      } catch {
        // fall through
      }
    }
    return this.resolveProvider(task.projectId, settings);
  }

  private async models(projectId: string, providerId: string): Promise<ModelInfo[]> {
    const key = `${projectId}:${providerId}`;
    const cached = this.modelCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.models;
    try {
      const result = await this.sdk.providers.models({ projectId, providerId });
      const models = result.models.map((model) => ({
        model: model.model,
        isDefault: model.isDefault,
        efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        defaultEffort: model.defaultReasoningEffort,
      }));
      this.modelCache.set(key, { at: Date.now(), models });
      return models;
    } catch (error) {
      this.bb.log.warn(`model list for ${providerId}: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Claude models map tiers to families (light → haiku … hardest → fable).
   * The catalog lists newer models first, so the first match is the newest.
   * Other providers keep their default model and vary only the effort.
   */
  private pickModel(models: ModelInfo[], providerId: string | null, tier: Tier): ModelInfo | null {
    if (models.length === 0) return null;
    const fallback = models.find((model) => model.isDefault) ?? models[0] ?? null;
    if (providerId !== "claude-code") return fallback;
    const family = TIER_FAMILIES[tier];
    return models.find((model) => model.model.includes(family)) ?? fallback;
  }

  /** The closest effort the model supports, preferring lower on a tie. */
  private pickEffort(model: ModelInfo, wanted: Effort): string | undefined {
    if (model.efforts.length === 0) return undefined;
    if (model.efforts.includes(wanted)) return wanted;
    const target = EFFORTS.indexOf(wanted);
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const effort of model.efforts) {
      const index = EFFORTS.indexOf(effort as Effort);
      if (index < 0) continue;
      const distance = Math.abs(index - target);
      if (distance < bestDistance) {
        best = effort;
        bestDistance = distance;
      }
    }
    return best ?? model.defaultEffort;
  }
}

export type { Stage };
