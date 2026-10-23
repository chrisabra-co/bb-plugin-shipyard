import type { DragEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RUNNING_PHASES, statusLabel } from "../constants";
import type { Task } from "../model";
import { Chip, Spinner } from "./shared";

export const DRAG_TYPE = "application/x-bb-shipyard-task";

function statusTone(task: Task): "running" | "good" | "bad" | "muted" {
  if (RUNNING_PHASES.has(task.phase)) return "running";
  if (task.reviewReason === "errors" || task.reviewReason === "qa_rejected" || task.error) return "bad";
  if (task.reviewReason === "completed" || task.reviewReason === "pr_created" || task.reviewReason === "merged")
    return "good";
  return "muted";
}

export function TaskCard({
  task,
  threadActive,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  task: Task;
  threadActive: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const tone = statusTone(task);
  const label = statusLabel(task);
  const running = tone === "running";
  const failingChecks = task.report?.checks.filter((check) => !check.passed).length ?? 0;

  const handleDragStart = (event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData(DRAG_TYPE, task.id);
    event.dataTransfer.effectAllowed = "move";
    onDragStart();
  };

  return (
    <button
      type="button"
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      data-task-id={task.id}
      className={cn(
        "group flex w-full cursor-grab flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left text-sm shadow-xs transition-colors",
        "hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <span className="line-clamp-3 font-medium leading-snug text-foreground">{task.title}</span>

      {label ? (
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs",
            tone === "bad" ? "text-destructive" : tone === "good" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {running ? (
            threadActive ? (
              <Spinner className="text-primary" />
            ) : (
              <Icon name="Hourglass" aria-hidden className="size-3.5" />
            )
          ) : tone === "bad" ? (
            <Icon name="AlertCircle" aria-hidden className="size-3.5" />
          ) : tone === "good" ? (
            <Icon name="Check" aria-hidden className="size-3.5 text-primary" />
          ) : null}
          <span className="truncate">{label}</span>
        </span>
      ) : null}

      {task.triage || task.changedFiles.length > 0 || task.pullRequest || task.report ? (
        <span className="flex flex-wrap items-center gap-1">
          {task.triage && task.triage.source !== "off" ? (
            <Chip title={task.triage.model ?? undefined}>
              {task.triage.tier} · {task.triage.effort}
            </Chip>
          ) : null}
          {task.changedFiles.length > 0 ? (
            <Chip title={task.changedFiles.slice(0, 20).join("\n")}>
              {task.changedFiles.length} {task.changedFiles.length === 1 ? "file" : "files"}
            </Chip>
          ) : null}
          {task.report ? (
            <Chip
              tone={task.report.status === "passed" ? "good" : task.report.status === "failed" ? "bad" : "warn"}
              title={task.report.summary}
            >
              {task.report.status === "passed"
                ? "checks passed"
                : failingChecks > 0
                  ? `${failingChecks} failing`
                  : task.report.status}
            </Chip>
          ) : null}
          {task.pullRequest?.number ? <Chip>PR #{task.pullRequest.number}</Chip> : null}
        </span>
      ) : null}
    </button>
  );
}
