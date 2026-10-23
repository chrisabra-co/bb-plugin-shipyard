Plan coding work on a Kanban board and let agents do it in parallel. Nothing
reaches your branch until you review it.

## What you get

- A **Shipyard** page with six columns: Planning, Queue, In Progress,
  AI Review, Human Review, and Done.
- One bb thread and git worktree for each task. You can watch the agent or type
  into its thread at any time.
- A short triage turn that picks the model and effort for each task, so a
  one-line fix does not use the largest model.
- A validation step before your review: the agent runs the project's checks
  and reviews its own diff with fresh eyes.
- Request changes, pull requests, and merges from the task card.
- Project lessons that every later task follows.
- A `bb shipyard` command, so any agent thread can manage the board.

## How it works

Tasks live in this plugin's storage on the bb server. The agents run through
your own bb providers and accounts. Pull requests need the GitHub CLI (`gh`)
on the machine that holds the project.
