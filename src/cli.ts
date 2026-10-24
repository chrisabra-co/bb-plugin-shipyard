// `bb shipyard …` — lets any agent or person read and drive the board.
// This replaces the Insights chat of proactive-agent/workbench: any bb thread in the project can
// create, start, move, and review tasks through these commands.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import type { Engine } from "./engine";
import {
  COLUMNS,
  COLUMN_LABELS,
  type ColumnId,
  PLAN_MODES,
  PLAN_MODE_LABELS,
  type PlanMode,
  statusLabel,
} from "./model";
import { type StoredTask, type Store, publicTask } from "./store";

const MAX_LIST = 200;

function requireProject(projectId: string | undefined, flag: string | undefined): string {
  const id = flag ?? projectId;
  if (!id) {
    throw new PluginCliError("no project in context", {
      code: "project_required",
      hint: "Add --project <project-id> (see `bb project list`).",
    });
  }
  return id;
}

function cardLine(task: StoredTask): string {
  const status = statusLabel(publicTask(task));
  const tier = task.triage ? ` [${task.triage.tier}/${task.triage.effort}]` : "";
  return `${task.id}  ${task.title}${tier}${status ? ` — ${status}` : ""}`;
}

function detail(task: StoredTask, store: Store): string {
  const lines = [
    `${task.id}  ${task.title}`,
    `Column: ${COLUMN_LABELS[task.column]}   Status: ${statusLabel(publicTask(task)) || "—"}`,
  ];
  if (task.threadId) lines.push(`Thread: @thread:${task.threadId}${task.branch ? `   Branch: ${task.branch}` : ""}`);
  if (task.pullRequest) lines.push(`Pull request: ${task.pullRequest.url}`);
  if (task.error) lines.push(`Error: ${task.error}`);
  if (task.signal && (task.reviewReason === "blocked" || task.reviewReason === "needs_input")) {
    lines.push(
      `The agent ${task.reviewReason === "blocked" ? "is blocked" : "needs your input"}: ${task.signal.summary}`,
      `Answer with: bb shipyard feedback ${task.id} "<answer>"`,
    );
  }
  lines.push(`Plan: ${PLAN_MODE_LABELS[task.planMode]}`);
  if (task.description) lines.push("", task.description.slice(0, 4000));
  if (task.plan) lines.push("", "Plan:", task.plan.slice(0, 4000));
  if (task.triage) {
    lines.push(
      "",
      `Triage (${task.triage.source}): ${task.triage.tier}${task.triage.model ? ` → ${task.triage.model}` : ""}, ${task.triage.effort} effort, scope ${task.triage.scope}, ${task.triage.needsPlan ? "plan first" : "no plan"}`,
      task.triage.reasoning,
    );
  }
  if (task.report) {
    lines.push("", `Validation: ${task.report.status}`, task.report.summary.slice(0, 2000));
    for (const check of task.report.checks) {
      lines.push(`  ${check.passed ? "✓" : "✗"} ${check.name}${check.command ? ` (${check.command})` : ""}`);
    }
    for (const finding of task.report.findings) {
      lines.push(`  [${finding.severity}${finding.fixed ? ", fixed" : ""}] ${finding.description}`);
    }
  }
  if (task.changedFiles.length > 0) {
    lines.push("", `Changed files (${task.changedFiles.length}):`, ...task.changedFiles.slice(0, 40).map((file) => `  ${file}`));
  }
  const events = store.listEvents(task.id, 15);
  if (events.length > 0) {
    lines.push("", "Recent activity:");
    for (const event of events) {
      lines.push(`  ${new Date(event.at).toISOString().slice(0, 16).replace("T", " ")}  ${event.message.slice(0, 200)}`);
    }
  }
  return lines.join("\n");
}

export function registerCli(bb: BbPluginApi, store: Store, engine: Engine): void {
  const findTask = (id: string): StoredTask => {
    const task = store.findTask(id);
    if (!task) {
      throw new PluginCliError(`no task matches "${id}"`, {
        code: "task_not_found",
        hint: "Run `bb shipyard list` to see task ids. A unique prefix works.",
      });
    }
    return task;
  };
  const projectOption = {
    type: "string" as const,
    description: "Project id (defaults to the current thread's project)",
  };
  const json = { type: "boolean" as const, description: "Print JSON" };

  bb.cli.register(
    defineCli({
      name: "shipyard",
      summary: "Plan, run, and review agent tasks on the project's Shipyard board",
      commands: {
        list: cliCommand({
          summary: "List the board's tasks by column",
          options: {
            project: projectOption,
            column: {
              type: "enum",
              values: [...COLUMNS],
              description: "Only this column",
            },
            json,
          },
          async run(input, ctx) {
            const projectId = requireProject(ctx.projectId, input.options.project);
            const tasks = store
              .listTasks(projectId)
              .filter((task) => !input.options.column || task.column === input.options.column)
              .slice(0, MAX_LIST);
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(tasks.map(publicTask), null, 2) };
            }
            const sections = COLUMNS.filter((column) => !input.options.column || column === input.options.column).map(
              (column) => {
                const cards = tasks.filter((task) => task.column === column);
                return `${COLUMN_LABELS[column]} (${cards.length})\n${cards.length ? cards.map((task) => `  ${cardLine(task)}`).join("\n") : "  —"}`;
              },
            );
            return { exitCode: 0, stdout: sections.join("\n\n") };
          },
        }),
        show: cliCommand({
          summary: "Show a task's details, triage, validation report, and activity",
          positionals: [{ name: "id", description: "Task id or unique prefix", required: true }],
          options: { json },
          async run(input) {
            const task = findTask(input.positionals.id);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ...publicTask(task), events: store.listEvents(task.id, 50) }, null, 2),
              };
            }
            return { exitCode: 0, stdout: detail(task, store) };
          },
        }),
        create: cliCommand({
          summary: "Create a task in Ideas; --start queues it and --brainstorm opens a brainstorm",
          positionals: [{ name: "description", description: "What the agent should do", required: true }],
          options: {
            title: { type: "string", description: "Short title (triage writes one when omitted)" },
            start: { type: "boolean", description: "Queue the task now" },
            brainstorm: { type: "boolean", description: "Start a brainstorm thread to shape the task with you" },
            plan: { type: "enum", values: [...PLAN_MODES], description: "Plan first: auto (triage decides), always, or skip" },
            project: projectOption,
          },
          async run(input, ctx) {
            const projectId = requireProject(ctx.projectId, input.options.project);
            if (input.options.start && input.options.brainstorm) {
              throw new PluginCliError("use --start or --brainstorm, not both", { code: "invalid_options" });
            }
            const task = await engine.createTask({
              projectId,
              title: input.options.title,
              description: input.positionals.description,
              destination: input.options.start ? "queue" : input.options.brainstorm ? "brainstorm" : "ideas",
              planMode: input.options.plan as PlanMode | undefined,
            });
            return { exitCode: 0, stdout: `Created ${cardLine(task)}` };
          },
        }),
        idea: cliCommand({
          summary: "Save an idea in the Ideas column for later",
          positionals: [{ name: "text", description: "The idea, in a sentence or two", required: true }],
          options: { project: projectOption },
          async run(input, ctx) {
            const projectId = requireProject(ctx.projectId, input.options.project);
            const task = await engine.createTask({ projectId, description: input.positionals.text, destination: "ideas" });
            return { exitCode: 0, stdout: `Saved ${cardLine(task)}` };
          },
        }),
        start: cliCommand({
          summary: "Queue a task from Ideas or Brainstorm, or continue a stopped one",
          positionals: [{ name: "id", description: "Task id or unique prefix", required: true }],
          async run(input) {
            const task = await engine.runAction(findTask(input.positionals.id).id, "start");
            return { exitCode: 0, stdout: cardLine(task) };
          },
        }),
        move: cliCommand({
          summary: "Move a task to a column; moving forward makes the agent pick it up from there",
          positionals: [
            { name: "id", description: "Task id or unique prefix", required: true },
            { name: "column", description: `One of: ${COLUMNS.join(", ")}`, required: true },
          ],
          async run(input) {
            const column = input.positionals.column as ColumnId;
            if (!COLUMNS.includes(column)) {
              throw new PluginCliError(`unknown column "${input.positionals.column}"`, {
                code: "invalid_column",
                hint: `Use one of: ${COLUMNS.join(", ")}`,
              });
            }
            const task = await engine.moveTask(findTask(input.positionals.id).id, column);
            return { exitCode: 0, stdout: cardLine(task) };
          },
        }),
        approve: cliCommand({
          summary: "Approve a task's plan so the agent implements it",
          positionals: [{ name: "id", description: "Task id or unique prefix", required: true }],
          async run(input) {
            const task = await engine.runAction(findTask(input.positionals.id).id, "approve_plan");
            return { exitCode: 0, stdout: cardLine(task) };
          },
        }),
        stop: cliCommand({
          summary: "Stop a running task and move it to Human Review",
          positionals: [{ name: "id", description: "Task id or unique prefix", required: true }],
          async run(input) {
            const task = await engine.runAction(findTask(input.positionals.id).id, "stop");
            return { exitCode: 0, stdout: cardLine(task) };
          },
        }),
        feedback: cliCommand({
          summary: "Request changes on a reviewed task or plan; the same agent session continues",
          positionals: [
            { name: "id", description: "Task id or unique prefix", required: true },
            { name: "feedback", description: "The changes you want", required: true },
          ],
          options: {
            "start-over": {
              type: "boolean",
              description: "Discard the attempt and start a new thread with these notes",
            },
          },
          async run(input) {
            const task = await engine.requestChanges(
              findTask(input.positionals.id).id,
              input.positionals.feedback,
              input.options["start-over"] === true,
            );
            return { exitCode: 0, stdout: cardLine(task) };
          },
        }),
        pr: cliCommand({
          summary: "Ask the task's agent to push its branch and open a pull request",
          positionals: [{ name: "id", description: "Task id or unique prefix", required: true }],
          async run(input) {
            const task = await engine.runAction(findTask(input.positionals.id).id, "create_pr");
            return { exitCode: 0, stdout: cardLine(task) };
          },
        }),
        merge: cliCommand({
          summary: "Merge the task's pull request; on conflicts the agent resolves them and merges again",
          positionals: [{ name: "id", description: "Task id or unique prefix", required: true }],
          async run(input) {
            const task = await engine.runAction(findTask(input.positionals.id).id, "merge");
            return { exitCode: 0, stdout: cardLine(task) };
          },
        }),
        done: cliCommand({
          summary: "Mark a task done",
          positionals: [{ name: "id", description: "Task id or unique prefix", required: true }],
          async run(input) {
            const task = await engine.runAction(findTask(input.positionals.id).id, "done");
            return { exitCode: 0, stdout: cardLine(task) };
          },
        }),
        delete: cliCommand({
          summary: "Delete a task (its thread stays)",
          positionals: [{ name: "id", description: "Task id or unique prefix", required: true }],
          async run(input) {
            const task = findTask(input.positionals.id);
            await engine.deleteTask(task.id);
            return { exitCode: 0, stdout: `Deleted ${task.id}` };
          },
        }),
        learn: cliCommand({
          summary: "Record a project lesson that every later task receives",
          positionals: [{ name: "lesson", description: "The preference or convention, in one or two sentences", required: true }],
          options: { project: projectOption },
          async run(input, ctx) {
            const projectId = requireProject(ctx.projectId, input.options.project);
            const text = input.positionals.lesson.trim();
            if (!text || text.length > 1000) {
              throw new PluginCliError("a lesson must have 1 to 1000 characters", { code: "invalid_lesson" });
            }
            const lesson = engine.addLesson(projectId, text, ctx.threadId ? `thread ${ctx.threadId}` : "cli");
            return { exitCode: 0, stdout: `Recorded ${lesson.id}` };
          },
        }),
        lessons: cliCommand({
          summary: "List the project's lessons",
          options: { project: projectOption, json },
          async run(input, ctx) {
            const projectId = requireProject(ctx.projectId, input.options.project);
            const lessons = store.listLessons(projectId);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(lessons, null, 2) };
            return {
              exitCode: 0,
              stdout: lessons.length ? lessons.map((lesson) => `${lesson.id}  ${lesson.text}`).join("\n") : "No lessons yet.",
            };
          },
        }),
      },
    }),
  );
}
