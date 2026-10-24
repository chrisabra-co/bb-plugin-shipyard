// Shipyard for bb: a Kanban board of tasks. Each task runs in its own bb
// thread and git worktree, moves through triage, implementation and
// validation, then waits for human review before it merges.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerCli } from "./src/cli";
import { BOARD_CHANGED, Engine } from "./src/engine";
import {
  RUNNING_PHASES,
  STAGES,
  TASK_ACTIONS,
  columnSchema,
  doneInputSchema,
  lessonSchema,
  planModeSchema,
  reportSchema,
  settingsOverridesSchema,
  settingsPatchSchema,
  settingsSchema,
  skillNameSchema,
  skillSchema,
  stageSkillsSchema,
  taskEventSchema,
  taskSchema,
  triageSchema,
} from "./src/model";
import { threadInstructions } from "./src/prompts";
import { Settings } from "./src/settings";
import { DEFAULTS_ROW, Store, publicTask } from "./src/store";

export type { Lesson, Task, TaskEvent } from "./src/model";

const projectIdSchema = z.string().trim().min(1).max(100);
const taskIdSchema = z.string().trim().min(1).max(100);

export const rpcContract = defineRpcContract({
  board_get: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.object({
      tasks: z.array(taskSchema),
      lessons: z.array(lessonSchema),
      maxParallel: z.number(),
    }),
  },
  task_create: {
    input: z
      .object({
        projectId: projectIdSchema,
        title: z.string().trim().max(200).optional(),
        description: z.string().max(20_000),
        destination: z.enum(["ideas", "brainstorm", "queue"]),
        planMode: planModeSchema.optional(),
        stageSkills: stageSkillsSchema.optional(),
      })
      .strict()
      .refine((value) => value.description.trim() || value.title, {
        message: "Give the task a title or a description.",
      }),
    output: taskSchema,
  },
  task_edit: {
    input: z
      .object({
        id: taskIdSchema,
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
        planMode: planModeSchema.optional(),
        stageSkills: stageSkillsSchema.optional(),
      })
      .strict(),
    output: taskSchema,
  },
  task_move: {
    input: z
      .object({
        id: taskIdSchema,
        column: columnSchema,
        position: z.number().finite().optional(),
      })
      .strict(),
    output: taskSchema,
  },
  task_action: {
    input: z.object({ id: taskIdSchema, action: z.enum(TASK_ACTIONS) }).strict(),
    output: taskSchema,
  },
  task_request_changes: {
    input: z
      .object({
        id: taskIdSchema,
        feedback: z.string().trim().min(1).max(20_000),
        startOver: z.boolean(),
      })
      .strict(),
    output: taskSchema,
  },
  task_delete: {
    input: z.object({ id: taskIdSchema }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  task_events: {
    input: z.object({ id: taskIdSchema }).strict(),
    output: z.object({ events: z.array(taskEventSchema) }),
  },
  lesson_add: {
    input: z
      .object({ projectId: projectIdSchema, text: z.string().trim().min(1).max(1000) })
      .strict(),
    output: lessonSchema,
  },
  lesson_delete: {
    input: z.object({ id: z.string().trim().min(1).max(100) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  settings_get: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: settingsViewSchema(),
  },
  settings_set: {
    input: z
      .object({ projectId: projectIdSchema, scope: z.enum(["defaults", "project"]), patch: settingsPatchSchema })
      .strict(),
    output: settingsViewSchema(),
  },
  stage_skills_set: {
    input: z
      .object({
        projectId: projectIdSchema,
        scope: z.enum(["defaults", "project"]),
        stage: z.enum(STAGES),
        skills: z.array(skillNameSchema).max(10).nullable(),
      })
      .strict(),
    output: settingsViewSchema(),
  },
  skills_list: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.object({ skills: z.array(skillSchema) }),
  },
});

/** Everything the settings screen shows for one project. */
function settingsViewSchema() {
  return z.object({
    defaults: settingsSchema,
    overrides: settingsOverridesSchema,
    effective: settingsSchema,
    stageSkills: z.object({ defaults: stageSkillsSchema, project: stageSkillsSchema }),
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    maxParallel: {
      type: "number",
      label: "Parallel tasks per project",
      experimental_schema: z.number().int().min(1).max(24),
      default: 3,
    },
    providerId: {
      type: "string",
      label: "Agent provider",
      default: "",
      experimental_schema: z.string().trim().max(100),
    },
    triage: {
      type: "boolean",
      label: "Triage each task to pick the model, effort, and planning",
      default: true,
    },
    allowHardest: {
      type: "boolean",
      label: "Let triage pick the most capable model tier (Fable on Claude)",
      default: false,
    },
    planning: {
      type: "select",
      label: "Plan before implementing",
      options: ["auto", "always", "never"],
      experimental_optionLabels: {
        auto: "When triage asks for it",
        always: "Always",
        never: "Never",
      },
      default: "auto",
    },
    planApproval: {
      type: "boolean",
      label: "Wait for my approval of each plan before implementing",
      default: false,
    },
    commitPlans: {
      type: "boolean",
      label: "Commit plan and brainstorm documents that skills write",
      default: false,
    },
    validation: {
      type: "boolean",
      label: "Validate each task (checks and a fresh-eyes review) before human review",
      default: true,
    },
    permissionMode: {
      type: "select",
      label: "Agent permission mode",
      options: ["full", "auto", "accept-edits"],
      experimental_optionLabels: {
        full: "Full access (the worktree isolates the work)",
        auto: "Auto (a classifier reviews actions)",
        "accept-edits": "Accept edits",
      },
      default: "full",
    },
    baseBranch: {
      type: "string",
      label: "Base branch (empty for the project default)",
      default: "",
      experimental_schema: z.string().trim().max(200),
    },
    mergeMethod: {
      type: "select",
      label: "Pull request merge method",
      options: ["squash", "merge", "rebase"],
      default: "squash",
    },
    archiveOnDone: {
      type: "boolean",
      label: "Archive a task's thread when the task is done",
      default: false,
    },
  });

  const readSettings = async () => {
    const values = await settings.get();
    return settingsSchema.parse({
      ...values,
      providerId: values.providerId.trim(),
      baseBranch: values.baseBranch.trim(),
    });
  };

  const store = Store.open(bb);
  const config = new Settings(
    store,
    readSettings,
    (patch) => settings.experimental_set(patch as Parameters<typeof settings.experimental_set>[0]),
    await readSettings(),
  );
  const engine = new Engine(bb, store, config);

  settings.onChange(() => {
    // A higher limit can free slots for queued tasks.
    void config.refresh().then(() => {
      bb.realtime.publish(BOARD_CHANGED, { projectId: null });
      engine.pump();
    });
  });

  const settingsView = (projectId: string) => ({
    defaults: config.defaults(),
    overrides: config.overrides(projectId),
    effective: config.effective(projectId),
    stageSkills: { defaults: config.defaultStageSkills(), project: config.projectStageSkills(projectId) },
  });

  // --- Thread lifecycle -------------------------------------------------

  bb.events.on("thread.idle", ({ thread }) => engine.onThreadIdle(thread.id));
  bb.events.on("thread.failed", ({ thread, error }) =>
    engine.onThreadFailed(thread.id, error),
  );
  bb.events.on("turn.failed", (event) =>
    engine.onTurnFailed({
      threadId: event.threadId,
      requestId: event.requestId,
      errorInfo: event.errorInfo,
      rateLimits: event.rateLimits,
      attemptNumber: event.attemptNumber,
    }),
  );

  // Catch up after a restart or reload, then keep the queue moving.
  bb.background.service("queue", {
    async start(signal) {
      await engine.reconcile();
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (!signal.aborted) engine.pump();
      }
    },
  });

  // --- Agent tools ------------------------------------------------------

  bb.agents.registerTool({
    name: "shipyard_triage",
    description:
      "Record the triage decision for the current Shipyard task: model tier, effort, whether to plan, scope, a short title, and verification commands.",
    presentation: {
      label: { pending: "Recording triage", completed: "Recorded triage" },
      icon: { glyph: "SlidersHorizontal" },
    },
    parameters: triageSchema,
    async execute(input, { threadId }) {
      return engine.recordTriage(threadId, input);
    },
  });

  bb.agents.registerTool({
    name: "shipyard_report",
    description:
      "Record the validation report for the current Shipyard task: status, a summary for the reviewer, the checks you ran, and review findings.",
    presentation: {
      label: { pending: "Recording validation report", completed: "Recorded validation report" },
      icon: { glyph: "CircleCheck" },
    },
    parameters: reportSchema,
    async execute(input, { threadId }) {
      return engine.recordReport(threadId, input);
    },
  });

  bb.agents.registerTool({
    name: "shipyard_learn",
    description:
      "Record a durable preference or convention for this project, such as one learned from reviewer feedback. Later Shipyard tasks receive it. Not for one-off fixes.",
    presentation: {
      label: { pending: "Recording a project lesson", completed: "Recorded a project lesson" },
      icon: { glyph: "Brain" },
    },
    parameters: z.object({ lesson: z.string().trim().min(1).max(1000) }),
    async execute({ lesson }, { threadId }) {
      return engine.recordLesson(threadId, lesson);
    },
  });

  bb.agents.registerTool({
    name: "shipyard_spec",
    description:
      "Save the spec agreed in a Shipyard brainstorm to the task card: a short title and the spec in Markdown. Call it once the user agrees with the spec.",
    presentation: {
      label: { pending: "Saving the spec", completed: "Saved the spec" },
      icon: { glyph: "FileText" },
    },
    parameters: z.object({
      title: z.string().trim().min(1).max(200).optional(),
      spec: z.string().trim().min(1).max(20_000),
    }),
    async execute(input, { threadId }) {
      return engine.recordSpec(threadId, input);
    },
  });

  bb.agents.registerTool({
    name: "shipyard_done",
    description:
      'End the current Shipyard stage: status "done" with a one-line summary, or "blocked" / "needs_input" with exactly what the user must provide. Then end your turn.',
    presentation: {
      label: { pending: "Ending the stage", completed: "Ended the stage" },
      icon: { glyph: "CircleCheck" },
    },
    parameters: doneInputSchema,
    async execute(input, { threadId }) {
      return engine.recordDone(threadId, input);
    },
  });

  // Only task threads get the tools and the standing instructions. The task
  // is found by thread id in the plugin's own table, not from metadata the
  // agent could rewrite.
  bb.agents.configure((context) => {
    let task = store.taskByThread(context.thread.id);
    if (!task) {
      // The session can start before the engine stores the new thread id.
      // Accept the spawn seed only for a task of this project that has no
      // thread yet, so another thread cannot claim a task by writing metadata.
      const seeded = context.pluginMetadata.taskId;
      const candidate = typeof seeded === "string" ? store.getTask(seeded) : null;
      if (candidate && candidate.projectId === context.project.id && candidate.threadId === null) {
        task = candidate;
      }
    }
    if (!task) return { tools: [], skills: [] };
    const others = store
      .listTasks(task.projectId)
      .filter(
        (other) =>
          other.id !== task.id &&
          other.threadId !== null &&
          (RUNNING_PHASES.has(other.phase) || other.column === "human_review"),
      );
    return {
      tools: ["shipyard_triage", "shipyard_report", "shipyard_learn", "shipyard_spec", "shipyard_done"],
      skills: [],
      instructions: threadInstructions({
        task,
        others,
        lessons: store.listLessons(task.projectId),
        commitPlans: config.effective(task.projectId).commitPlans,
      }),
    };
  });

  // --- RPC for the board ------------------------------------------------

  bb.rpc.register(rpcContract, {
    board_get({ projectId }) {
      const { maxParallel } = config.effective(projectId);
      return {
        tasks: store.listTasks(projectId).map(publicTask),
        lessons: store.listLessons(projectId),
        maxParallel,
      };
    },
    async task_create(input) {
      return publicTask(await engine.createTask(input));
    },
    async task_edit({ id, ...patch }) {
      return publicTask(await engine.editTask(id, patch));
    },
    async task_move({ id, column, position }) {
      return publicTask(await engine.moveTask(id, column, position));
    },
    async task_action({ id, action }) {
      return publicTask(await engine.runAction(id, action));
    },
    async task_request_changes({ id, feedback, startOver }) {
      return publicTask(await engine.requestChanges(id, feedback, startOver));
    },
    async task_delete({ id }) {
      await engine.deleteTask(id);
      return { ok: true as const };
    },
    task_events({ id }) {
      return { events: store.listEvents(id) };
    },
    lesson_add({ projectId, text }) {
      return engine.addLesson(projectId, text, "user");
    },
    lesson_delete({ id }) {
      const ok = store.deleteLesson(id);
      if (ok) bb.realtime.publish(BOARD_CHANGED, { projectId: null });
      return { ok };
    },
    settings_get({ projectId }) {
      return settingsView(projectId);
    },
    async settings_set({ projectId, scope, patch }) {
      if (scope === "defaults") await config.setDefaults(patch);
      else config.setProjectOverrides(projectId, patch);
      bb.realtime.publish(BOARD_CHANGED, { projectId: scope === "defaults" ? null : projectId });
      engine.pump();
      return settingsView(projectId);
    },
    stage_skills_set({ projectId, scope, stage, skills }) {
      config.setStageSkills(scope === "defaults" ? DEFAULTS_ROW : projectId, stage, skills);
      bb.realtime.publish(BOARD_CHANGED, { projectId: scope === "defaults" ? null : projectId });
      return settingsView(projectId);
    },
    async skills_list({ projectId }) {
      // Without a setting or project default, ask the first available provider.
      const providerId =
        (await engine.resolveProvider(projectId, config.effective(projectId))) ??
        (await bb.sdk.providers.list().catch(() => [])).find((provider) => provider.available)?.id ??
        null;
      if (!providerId) return { skills: [] };
      try {
        const { commands } = await bb.sdk.projects.commands({ projectId, provider: providerId });
        const skills = commands
          .filter((command) => command.source === "skill")
          .map((command) => ({ name: command.name, description: command.description ?? "" }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { skills };
      } catch (error) {
        bb.log.warn(`skill list for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
        return { skills: [] };
      }
    },
  });

  registerCli(bb, store, engine);
}
