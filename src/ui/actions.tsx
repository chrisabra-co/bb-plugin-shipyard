// The actions a task offers in its current state. The task panel shows all
// of them; cards and list rows show the quick ones as icon buttons on hover.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { RUNNING_PHASES } from "../constants";
import type { ColumnId, Task, TaskAction } from "../model";
import { type ShipyardRpc, Spinner, attempt } from "./shared";

export type Run =
  | { kind: "action"; action: TaskAction }
  | { kind: "move"; column: ColumnId }
  | { kind: "thread" }
  | { kind: "url"; url: string };

export interface ActionDef {
  id: string;
  label: string;
  icon?: string;
  run: Run;
  /** primary: the one main action; secondary: outline; minor: ghost. */
  weight: "primary" | "secondary" | "minor";
  /** Shown as an icon button on the card and the list row. */
  quick: boolean;
}

export function taskActions(task: Task): ActionDef[] {
  const actions: ActionDef[] = [];
  const add = (def: ActionDef) => actions.push(def);
  const running = RUNNING_PHASES.has(task.phase);

  if (running) {
    add({ id: "stop", label: "Stop", icon: "Square", run: { kind: "action", action: "stop" }, weight: "secondary", quick: true });
  } else if (task.column === "ideas") {
    add({ id: "queue", label: "Queue it", icon: "Play", run: { kind: "action", action: "start" }, weight: "primary", quick: true });
    add({ id: "brainstorm", label: "Brainstorm", icon: "AiBrain01", run: { kind: "move", column: "brainstorm" }, weight: "secondary", quick: true });
    add({ id: "run", label: "Run now", icon: "Zap", run: { kind: "move", column: "in_progress" }, weight: "minor", quick: true });
  } else if (task.column === "brainstorm") {
    add({ id: "queue", label: "Queue it", icon: "Play", run: { kind: "action", action: "start" }, weight: "primary", quick: true });
    add({ id: "later", label: "Save for later", icon: "Archive", run: { kind: "move", column: "ideas" }, weight: "secondary", quick: true });
  } else if (task.column === "queue") {
    add({ id: "run", label: "Run now", icon: "Zap", run: { kind: "move", column: "in_progress" }, weight: "primary", quick: true });
    add({ id: "ideas", label: "Back to Ideas", icon: "ArrowLeft", run: { kind: "move", column: "ideas" }, weight: "secondary", quick: true });
  } else if (task.column === "human_review" && (task.reviewReason === "blocked" || task.reviewReason === "needs_input")) {
    // The answer goes in the Review tab; the thread holds the agent's context.
    if (task.threadId) {
      add({ id: "thread", label: "Open thread", icon: "SideChat", run: { kind: "thread" }, weight: "secondary", quick: true });
    }
    add({ id: "done", label: "Mark done", icon: "CircleCheck", run: { kind: "action", action: "done" }, weight: "minor", quick: true });
  } else if (task.column === "human_review" && task.reviewReason === "plan_ready") {
    add({ id: "approve", label: "Approve plan", icon: "Check", run: { kind: "action", action: "approve_plan" }, weight: "primary", quick: true });
  } else if (task.column === "human_review") {
    if (task.pullRequest) {
      add({ id: "merge", label: "Merge PR", icon: "GitMerge", run: { kind: "action", action: "merge" }, weight: "primary", quick: true });
      add({
        id: "open-pr",
        label: `Open PR #${task.pullRequest.number}`,
        icon: "ExternalLink",
        run: { kind: "url", url: task.pullRequest.url },
        weight: "secondary",
        quick: true,
      });
      if (task.pullRequest.attention === "conflicts") {
        add({ id: "conflicts", label: "Resolve conflicts", icon: "GitBranch", run: { kind: "action", action: "resolve_conflicts" }, weight: "secondary", quick: false });
      }
      add({ id: "refresh", label: "Refresh PR", icon: "RotateCcw", run: { kind: "action", action: "refresh_pr" }, weight: "minor", quick: false });
    } else if (task.threadId && task.triage) {
      add({ id: "pr", label: "Create PR", icon: "GitPullRequest", run: { kind: "action", action: "create_pr" }, weight: "primary", quick: true });
    } else {
      add({ id: "queue", label: "Queue it", icon: "Play", run: { kind: "move", column: "queue" }, weight: "primary", quick: true });
    }
    add({ id: "done", label: "Mark done", icon: "CircleCheck", run: { kind: "action", action: "done" }, weight: "minor", quick: true });
  } else if (task.column === "done") {
    add({ id: "reopen", label: "Reopen", icon: "RotateCcw", run: { kind: "move", column: "human_review" }, weight: "secondary", quick: true });
  }
  return actions;
}

/** Runs an action and tracks which one is busy. */
export function useActionRunner(rpc: ShipyardRpc, task: Task) {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (def: ActionDef) => {
    switch (def.run.kind) {
      case "thread":
        if (task.threadId) navigate.toThread(task.threadId, { split: true });
        return;
      case "url":
        navigate.openUrl(def.run.url);
        return;
      case "action":
        setBusy(def.id);
        await attempt(rpc.call("task_action", { id: task.id, action: def.run.action }));
        setBusy(null);
        return;
      case "move":
        setBusy(def.id);
        await attempt(rpc.call("task_move", { id: task.id, column: def.run.column }));
        setBusy(null);
        return;
    }
  };
  return { busy, run };
}

/**
 * Icon buttons for the quick actions, with tooltips. The parent shows them
 * on hover or keyboard focus through the `group` class.
 */
export function QuickActions({
  task,
  rpc,
  omit = [],
  className,
}: {
  task: Task;
  rpc: ShipyardRpc;
  /** Action ids the host already shows another way. */
  omit?: readonly string[];
  className?: string;
}) {
  const { busy, run } = useActionRunner(rpc, task);
  const quick = taskActions(task).filter((action) => action.quick && !omit.includes(action.id));
  if (task.threadId && !quick.some((action) => action.id === "thread")) {
    quick.push({ id: "thread", label: "Open thread", icon: "SideChat", run: { kind: "thread" }, weight: "minor", quick: true });
  }
  if (quick.length === 0) return null;
  return (
    <TooltipProvider delayDuration={300}>
      <div role="toolbar" aria-label={`Actions for ${task.title}`} className={cn("flex items-center gap-0.5", className)}>
        {quick.map((action) => (
          <Tooltip key={action.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={action.label}
                disabled={busy !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  void run(action);
                }}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-md outline-none",
                  "focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  action.weight === "primary"
                    ? "text-foreground hover:bg-primary/15 hover:text-primary"
                    : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
                )}
              >
                {busy === action.id ? (
                  <Spinner />
                ) : (
                  <Icon name={action.icon ?? "MoreHorizontal"} aria-hidden className="size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>{action.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
