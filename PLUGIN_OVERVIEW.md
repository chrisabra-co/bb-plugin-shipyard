## What you get

- A **Shipyard** page with six columns: Planning, Queue, In Progress,
  AI Review, Human Review, and Done. Moving a card is a command: drop it in
  Queue to schedule it, or in In Progress to run it now.
- One bb thread and git worktree for each task. You can open the thread to
  watch the agent or type to it at any time.
- A short triage turn for each task. It picks the model tier, the effort, and
  whether the agent plans first. On Claude Code, a one-line fix runs on Haiku
  and a cross-module change runs on Opus.
- A validation step before your review. The agent runs the project's checks,
  reviews its own diff with fresh eyes, and fixes correctness problems. The card
  shows the checks, the findings, and a summary for you.
- Review actions on the card: request changes (the same session continues),
  create a pull request, merge it, or mark the task done.
- Project lessons. When your feedback shows a lasting preference, the agent
  records it, and every later task follows it. You can add lessons yourself.

## How it works

Shipyard runs up to three tasks per project at once by default. The others
wait in Queue. Each running agent sees the files that the project's other open
tasks change, so it avoids edits that would conflict at merge time.

A rate-limited turn retries when the provider's limit resets. If a merge has
conflicts, the agent merges the base branch into its branch, resolves the
conflicts, pushes, and Shipyard merges again.

Any thread in the project can drive the board with the `bb shipyard` command,
for example `bb shipyard create "Add CSV export" --start`. A bundled skill
teaches agents these commands.

Tasks are stored on your bb server. Agents run through the providers and
accounts you already use in bb, so each task spends tokens on your plans.

## Requirements

- A bb project with a git repository.
- Pull requests and merges need a GitHub remote and the GitHub CLI (`gh`) on
  the machine that holds the project.
- Model selection by tier works on Claude Code. Other providers keep their
  default model, and triage changes only the effort.
