// Shipyard for bb: a Kanban board of tasks. Each task runs in its own bb
// thread and git worktree, moves through triage, implementation and
// validation, then waits for human review before it merges.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerCli } from "./src/cli";
import { BOARD_CHANGED, Engine, type ShipyardSettings } from "./src/engine";
import {
  RUNNING_PHASES,
  TASK_ACTIONS,
  columnSchema,
  lessonSchema,
  reportSchema,
  taskEventSchema,
  taskSchema,
  triageSchema,
} from "./src/model";
import { threadInstructions } from "./src/prompts";
import { Store, publicTask } from "./src/store";

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
        start: z.boolean(),
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
});

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

  const readSettings = async (): Promise<ShipyardSettings> => {
    const values = await settings.get();
    return {
      maxParallel: values.maxParallel,
      providerId: values.providerId.trim(),
      triage: values.triage,
      allowHardest: values.allowHardest,
      planning: values.planning as ShipyardSettings["planning"],
      validation: values.validation,
      permissionMode: values.permissionMode as ShipyardSettings["permissionMode"],
      baseBranch: values.baseBranch.trim(),
      mergeMethod: values.mergeMethod as ShipyardSettings["mergeMethod"],
      archiveOnDone: values.archiveOnDone,
    };
  };

  const store = Store.open(bb);
  const engine = new Engine(bb, store, readSettings);

  settings.onChange(() => {
    // A higher limit can free slots for queued tasks.
    engine.pump();
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
      icon: { glyph: "Gauge" },
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
      icon: { glyph: "ClipboardCheck" },
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
      icon: { glyph: "Lightbulb" },
    },
    parameters: z.object({ lesson: z.string().trim().min(1).max(1000) }),
    async execute({ lesson }, { threadId }) {
      return engine.recordLesson(threadId, lesson);
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
      tools: ["shipyard_triage", "shipyard_report", "shipyard_learn"],
      skills: [],
      instructions: threadInstructions({
        task,
        others,
        lessons: store.listLessons(task.projectId),
      }),
    };
  });

  // --- RPC for the board ------------------------------------------------

  bb.rpc.register(rpcContract, {
    async board_get({ projectId }) {
      const { maxParallel } = await readSettings();
      return {
        tasks: store.listTasks(projectId).map(publicTask),
        lessons: store.listLessons(projectId),
        maxParallel,
      };
    },
    async task_create({ projectId, title, description, start }) {
      return publicTask(await engine.createTask({ projectId, title, description, start }));
    },
    async task_edit({ id, title, description }) {
      return publicTask(await engine.editTask(id, { title, description }));
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
  });

  registerCli(bb, store, engine);
}
