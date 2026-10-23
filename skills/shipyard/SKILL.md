---
name: shipyard
description: Plan, run, and review agent tasks on the project's Shipyard Kanban board with `bb shipyard`. Use when the user asks to add tasks to the board, check what agents are doing, review or merge task results, or record a project lesson.
---

# Shipyard

Shipyard is a Kanban board of coding tasks for a bb project. Each task runs in
its own visible bb thread and git worktree. The board has six columns:

| Column | Meaning |
| --- | --- |
| `planning` | Draft. Nothing runs. |
| `queue` | Starts when the project has a free slot (setting `maxParallel`). |
| `in_progress` | The agent triages the task, then implements it. |
| `ai_review` | The agent runs the checks and reviews its own diff with fresh eyes. |
| `human_review` | The user reviews: request changes, open a PR, merge, or mark done. |
| `done` | Finished. |

Moving a card forward is a command. `queue` waits for a slot, `in_progress`
starts or continues now, and `ai_review` runs validation again.

## Commands

All commands use the current thread's project. Add `--project <id>` outside a
project thread. Task ids accept a unique prefix.

```sh
bb shipyard list [--column human_review] [--json]
bb shipyard show <id> [--json]                # triage, validation report, files, activity
bb shipyard create "<description>" [--title "<title>"] [--start]
bb shipyard start <id>                        # queue from Planning, or continue a stopped task
bb shipyard move <id> <column>
bb shipyard stop <id>
bb shipyard feedback <id> "<changes>" [--start-over]
bb shipyard pr <id>                           # agent pushes and opens a GitHub PR
bb shipyard merge <id>                        # merges the PR; resolves conflicts first if needed
bb shipyard done <id>
bb shipyard delete <id>
bb shipyard learn "<lesson>"                  # a lasting project preference
bb shipyard lessons
```

## How to help the user

- When the user describes several pieces of work, create one task for each
  independent piece. Write the description as a goal with constraints and a
  clear "done" condition. Add `--start` only when the user wants the work to
  begin now.
- Prefer small tasks that touch different files. Parallel tasks merge into
  the same base branch.
- To report status, run `bb shipyard list`. For a task in `human_review`, run
  `bb shipyard show <id>` and summarize its validation report and open
  findings.
- Do not merge, discard, or delete a task unless the user asks.
- Record a lesson only for a lasting preference, not for a one-off fix.

## Inside a task thread

A task thread gets three tools: `shipyard_triage`, `shipyard_report`, and
`shipyard_learn`. The Shipyard prompts tell the agent when to call each one.
Do not call them in other threads.
