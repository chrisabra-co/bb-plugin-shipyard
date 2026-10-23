# Shipyard for bb

A Kanban board for coding agents. You write tasks. Each task runs in its own
bb thread and git worktree, so your main branch stays untouched until you
review and merge.

Shipyard ports the workflow of
[proactive-agent/workbench](https://github.com/proactive-agent/workbench) to bb.

## How a task runs

| Column | What happens |
| --- | --- |
| Planning | You draft the task. Nothing runs. |
| Queue | The task waits for a free slot (`maxParallel` per project). |
| In Progress | A short triage turn picks the model tier, effort, and whether to plan. The same session then implements, verifies, and commits. |
| AI Review | The same session runs the project's checks, reviews its diff with fresh eyes, and reports through the `shipyard_report` tool. |
| Human Review | You review. You request changes (the session continues), open a PR, merge, or mark it done. |
| Done | Finished. |

Moving a card is a command. Drag it to Queue to schedule it, to In Progress to
run it now, or to AI Review to validate again.

- **Triage.** On Claude Code, the tiers map to model families: light → Haiku,
  standard → Sonnet, deep → Opus, hardest → Fable (off by default). Other
  providers keep their default model and vary only the effort.
- **Parallel tasks.** Each agent sees the files the project's other open
  tasks change, so it can avoid merge conflicts.
- **Lessons.** Agents record lasting preferences from your feedback with
  `shipyard_learn`. You can add lessons on the board or with
  `bb shipyard learn`. Every later task in the project receives them.
- **Pull requests.** "Create PR" asks the agent to push and run `gh pr create`.
  "Merge PR" uses bb's merge. On conflicts, the agent merges the base branch,
  pushes, and Shipyard merges again once.
- **Rate limits.** A rate-limited turn retries when the limit resets, up to
  five times.

## CLI

Any thread in the project can drive the board. The bundled skill teaches
agents these commands:

```sh
bb shipyard list | show <id> | create "<description>" [--start]
bb shipyard start | move | stop | feedback | pr | merge | done | delete
bb shipyard learn "<lesson>" | lessons
```

## Settings

`bb plugin config shipyard` or Settings → Plugins → Shipyard:
parallel tasks per project, agent provider, triage on or off, allow the top
tier, planning policy, validation on or off, permission mode (default `full`,
because the worktree isolates the work), base branch, merge method, and
archiving threads on Done.

## Requirements

- A bb project with a git repository.
- For pull requests: a GitHub remote and the GitHub CLI (`gh`) on the machine
  that holds the project.

## Install

```sh
bb plugin install git:https://github.com/chrisabra-co/bb-plugin-shipyard.git
```

## Develop

```sh
npm install --include=dev
npm run typecheck
bb plugin install .   # or: bb plugin dev
```

## License

MIT. The triage, implementation, and validation prompts are adapted from
proactive-agent/workbench (MIT). See [LICENSE](LICENSE).
