import type { DragEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RUNNING_PHASES, TRACK, type TrackStep, shortModelName, statusLabel, trackStep } from "../constants";
import type { Task } from "../model";
import { Spinner } from "./shared";

export const DRAG_TYPE = "application/x-bb-shipyard-task";

const TRACK_LABELS: Record<TrackStep, string> = {
  triage: "Triage",
  plan: "Plan",
  implement: "Build",
  validate: "Validate",
};

export type Tone = "running" | "good" | "bad" | "attention" | "muted";

export function statusTone(task: Task): Tone {
  if (RUNNING_PHASES.has(task.phase)) return "running";
  if (task.reviewReason === "errors" || task.reviewReason === "qa_rejected" || task.error) return "bad";
  if (task.reviewReason === "plan_ready" || task.reviewReason === "blocked" || task.reviewReason === "needs_input")
    return "attention";
  if (task.reviewReason === "completed" || task.reviewReason === "pr_created" || task.reviewReason === "merged")
    return "good";
  return "muted";
}

export function StatusLine({ task, threadActive }: { task: Task; threadActive: boolean }) {
  const tone = statusTone(task);
  const label = statusLabel(task);
  if (!label) return null;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        tone === "bad" ? "text-destructive" : tone === "good" || tone === "attention" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {tone === "running" ? (
        threadActive ? (
          <Spinner className="text-primary" />
        ) : (
          <Icon name="Clock" aria-hidden className="size-3.5" />
        )
      ) : tone === "bad" ? (
        <Icon name="AlertCircle" aria-hidden className="size-3.5" />
      ) : tone === "attention" ? (
        <Icon
          name={task.reviewReason === "plan_ready" ? "FileText" : "AlertTriangle"}
          aria-hidden
          className="size-3.5 text-primary"
        />
      ) : tone === "good" ? (
        <Icon name="Check" aria-hidden className="size-3.5 text-primary" />
      ) : task.phase === "brainstorm" ? (
        <Icon name="MessageCirclePlus" aria-hidden className="size-3.5" />
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Triage, Plan, Build, Validate: done, current, next, or skipped. */
export function StageTrack({ task, compact = false }: { task: Task; compact?: boolean }) {
  // A stopped stage shows where it stopped.
  const stopped = (task.reviewReason === "blocked" || task.reviewReason === "needs_input") && task.signal;
  const current = trackStep(stopped ? { ...task, phase: task.signal?.phase ?? task.phase } : task);
  const reviewing = task.column === "human_review" || task.column === "done";
  if (!current && !reviewing) return null;
  const currentIndex = current ? TRACK.indexOf(current) : TRACK.length;
  const skippedPlan = task.plan === null && currentIndex > 1 && task.reviewReason !== "plan_ready";
  const planWaiting = task.reviewReason === "plan_ready";
  return (
    <ol aria-label="Stages" title={compact ? TRACK.map((step) => TRACK_LABELS[step]).join(", ") : undefined} className="grid grid-cols-4 gap-1">
      {TRACK.map((step, index) => {
        const skipped = step === "plan" && skippedPlan;
        const state = planWaiting
          ? index <= 1
            ? index === 1
              ? "current"
              : "done"
            : "next"
          : skipped
            ? "skipped"
            : index < currentIndex
              ? "done"
              : index === currentIndex
                ? "current"
                : "next";
        return (
          <li key={step} className="min-w-0">
            <span
              aria-hidden
              className={cn(
                "block h-1 rounded-full",
                state === "done" && "bg-foreground/50",
                state === "current" && "bg-primary",
                state === "next" && "bg-border",
                state === "skipped" && "border-t border-dashed border-border bg-transparent",
              )}
            />
            <span
              className={cn(
                compact ? "sr-only" : "mt-1 block truncate text-[11px] leading-none",
                state === "current" ? "text-foreground" : "text-muted-foreground",
                state === "skipped" && "line-through",
              )}
            >
              <span className="sr-only">
                {state === "done" ? "Done: " : state === "current" ? "Current: " : state === "skipped" ? "Skipped: " : "Next: "}
              </span>
              {TRACK_LABELS[step]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Meta({ children, title, tone }: { children: ReactNode; title?: string; tone?: "bad" | "good" }) {
  return (
    <span
      title={title}
      className={cn(
        "text-[11px] leading-none",
        tone === "bad" ? "text-destructive" : tone === "good" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function TaskCard({
  task,
  threadActive,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging,
  selected,
  onQueue,
  onSaveForLater,
  actions,
}: {
  task: Task;
  threadActive: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
  selected: boolean;
  onQueue: () => void;
  onSaveForLater: () => void;
  /** Quick actions, shown over the card's corner on hover or focus. */
  actions?: ReactNode;
}) {
  const failingChecks = task.report?.checks.filter((check) => !check.passed).length ?? 0;
  const model = shortModelName(task.triage?.model ?? null);

  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.setData(DRAG_TYPE, task.id);
    event.dataTransfer.effectAllowed = "move";
    onDragStart();
  };

  const meta: ReactNode[] = [];
  if (model) meta.push(<Meta key="model" title={task.triage?.model ?? undefined}>{model}</Meta>);
  if (task.changedFiles.length > 0)
    meta.push(
      <Meta key="files" title={task.changedFiles.slice(0, 20).join("\n")}>
        {task.changedFiles.length} {task.changedFiles.length === 1 ? "file" : "files"}
      </Meta>,
    );
  if (task.report)
    meta.push(
      <Meta
        key="checks"
        title={task.report.summary}
        tone={task.report.status === "passed" ? "good" : task.report.status === "failed" ? "bad" : undefined}
      >
        {task.report.status === "passed"
          ? "Checks passed"
          : failingChecks > 0
            ? `${failingChecks} failing`
            : task.report.status === "partial"
              ? "Some checks skipped"
              : "Checks failed"}
      </Meta>,
    );
  if (task.pullRequest?.number) meta.push(<Meta key="pr">PR #{task.pullRequest.number}</Meta>);

  return (
    <article
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      data-task-id={task.id}
      className={cn(
        "group relative flex w-full cursor-grab flex-col gap-2.5 rounded-lg border bg-card p-3 text-sm shadow-xs active:cursor-grabbing",
        "transition-colors motion-reduce:transition-none",
        selected ? "border-primary/60" : "border-border hover:border-foreground/20",
        dragging && "opacity-40",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${task.title}`}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {/* The stretched button above takes the clicks; only the action buttons sit over it. */}
      {actions && !dragging ? <HoverBar>{actions}</HoverBar> : null}
      <span className="line-clamp-3 font-medium leading-snug text-foreground">{task.title}</span>
      <StatusLine task={task} threadActive={threadActive} />
      <StageTrack task={task} compact />
      {meta.length > 0 ? <span className="flex flex-wrap items-center gap-x-3 gap-y-1">{meta}</span> : null}
      {task.column === "brainstorm" ? (
        <span className="relative flex gap-1.5">
          <Button size="sm" variant="outline" className="h-7 flex-1" onClick={onQueue}>
            Queue it
          </Button>
          <Button size="sm" variant="ghost" className="h-7 flex-1" onClick={onSaveForLater}>
            Save for later
          </Button>
        </span>
      ) : null}
    </article>
  );
}

/**
 * A small bar over the top-right corner. It shows on hover or keyboard focus,
 * and always on touch screens, which have no hover.
 */
export function HoverBar({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        "absolute right-1.5 top-1.5 z-10 rounded-md border border-border bg-card p-0.5 shadow-sm",
        "opacity-0 transition-opacity motion-reduce:transition-none",
        "group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
      )}
    >
      {children}
    </div>
  );
}
