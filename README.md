```text
         /\
        /  \________________________________
       |____|_______________________________|
       | |  |              ||
       | |  |             [##]                      _|_
       | |  |                    [##][##]          |   |
       | |  |    [##][##][##][##][##][##]          |[] |
       | |  |    [##][##][##][##][##][##][##][##]  |___|
       | |  |    [##][##][##][##][##][##][##][##]  |   |           _|
       | |  | _|___________________________________|___|___      _|__|_
_______| |  | \  o     o     o     o     o     o     o      /    \    /
==============~\___________________________________________/~~~~~~~~~~~~~~
  ~     ~      ~     ~       ~     ~      ~      ~     ~      ~     ~
     ~      ~     ~      ~      ~     ~     ~     ~      ~     ~

   ███████╗ ██╗  ██╗ ██╗ ██████╗  ██╗   ██╗  █████╗  ██████╗  ██████╗
   ██╔════╝ ██║  ██║ ██║ ██╔══██╗ ╚██╗ ██╔╝ ██╔══██╗ ██╔══██╗ ██╔══██╗
   ███████╗ ███████║ ██║ ██████╔╝  ╚████╔╝  ███████║ ██████╔╝ ██║  ██║
   ╚════██║ ██╔══██║ ██║ ██╔═══╝    ╚██╔╝   ██╔══██║ ██╔══██╗ ██║  ██║
   ███████║ ██║  ██║ ██║ ██║         ██║    ██║  ██║ ██║  ██║ ██████╔╝
   ╚══════╝ ╚═╝  ╚═╝ ╚═╝ ╚═╝         ╚═╝    ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═════╝
```

# Shipyard for bb

A Kanban board for coding agents. You write tasks. Each task runs in its own
bb thread and git worktree, so your main branch stays untouched until you
review and merge.

Shipyard ports the workflow of
[proactive-agent/workbench](https://github.com/proactive-agent/workbench) to bb.

## How a task runs

| Column | What happens |
| --- | --- |
| Ideas | You save ideas for later. Nothing runs. |
| Brainstorm | An agent asks you questions in its thread and writes the spec with you. Then you choose "Queue it" or "Save for later". |
| Queue | The task waits for a free slot (parallel tasks per project). |
| In Progress | The same session runs each stage: Triage, Plan (optional), Build, and Validate. The card shows the stage. |
| Human Review | You review the work, or approve the plan when plan approval is on. You request changes (the session continues), open a PR, merge, or mark it done. |
| Done | Finished. |

Moving a card is a command. Drag it to Brainstorm to start a brainstorm, to
Queue to schedule it, or to In Progress to run it now.

- **Triage.** On Claude Code, the tiers map to model families: light → Haiku,
  standard → Sonnet, deep → Opus, hardest → Fable (off by default). Other
  providers keep their default model and vary only the effort.
- **Plan first.** Each task has a plan mode: Auto (the project setting, and
  triage when the setting is automatic), Always, or Skip. The plan is its own
  turn. Shipyard keeps the plan on the card. With plan approval on, the task
  stops in Human Review until you approve the plan or ask for changes.
- **Skills by stage.** Pick skills for each stage, such as `ce-plan` for Plan
  or `hallmark` for Build. Defaults apply to every project. A project's list
  for a stage replaces the default list, and a task can add its own skills.
- **Explicit completion.** Each build stage ends when the agent calls
  `shipyard_done`. An agent that needs something only you can give (a secret,
  a decision) ends the stage as "blocked" or "needs input". The task waits in
  Human Review with its question, and your answer continues the same stage.
  If an agent stops without the tool, Shipyard treats the stage as done.
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

The page has a Board view and a List view. Click a task to open its panel
with the review, the task details, and the activity.

## CLI

Any thread in the project can drive the board. The bundled skill teaches
agents these commands:

```sh
bb shipyard list | show <id> | idea "<text>"
bb shipyard create "<description>" [--start | --brainstorm] [--plan auto|always|skip]
bb shipyard start | move | approve | stop | feedback | pr | merge | done | delete
bb shipyard learn "<lesson>" | lessons
```

## Settings

Open **Settings** on the Shipyard page. Switch between this project and all
projects. A project can override any default:

- Queue: parallel tasks per project.
- Pipeline: triage, the most capable model tier, plan first, plan approval,
  and validation.
- Agents: provider and permission mode (default `full`, because the worktree
  isolates the work).
- Git: base branch, merge method, whether to commit plan documents, and
  archiving threads on Done.
- Skills by stage.

The defaults are also on Settings → Plugins → Shipyard and in
`bb plugin config shipyard`.

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
