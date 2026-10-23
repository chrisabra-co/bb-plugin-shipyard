import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Markdown,
  experimental_VoiceInputTextarea as VoiceInputTextarea,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { COLUMN_LABELS, RUNNING_PHASES, statusLabel } from "../constants";
import type { Task, TaskAction, TaskEvent } from "../model";
import { Chip, type ShipyardRpc, attempt, relativeTime } from "./shared";

const textareaClass =
  "min-h-28 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function TaskDialog({
  task,
  rpc,
  onClose,
}: {
  task: Task | null;
  rpc: ShipyardRpc;
  onClose: () => void;
}) {
  const navigate = useBbNavigate();
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [feedback, setFeedback] = useState("");
  const [startOver, setStartOver] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const taskId = task?.id ?? null;
  const updatedAt = task?.updatedAt ?? 0;
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    rpc.call("task_events", { id: taskId }).then(
      (result) => {
        if (!cancelled) setEvents(result.events);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, taskId, updatedAt]);

  useEffect(() => {
    setEditing(false);
    setFeedback("");
    setStartOver(false);
  }, [taskId]);

  if (!task) {
    return (
      <Dialog open={false} onOpenChange={() => undefined}>
        <DialogContent />
      </Dialog>
    );
  }

  const running = RUNNING_PHASES.has(task.phase);
  const inReview = task.column === "human_review";
  const label = statusLabel(task);

  const act = async (action: TaskAction, key: string = action) => {
    setBusy(key);
    await attempt(rpc.call("task_action", { id: task.id, action }));
    setBusy(null);
  };
  const move = async (column: Task["column"]) => {
    setBusy(column);
    await attempt(rpc.call("task_move", { id: task.id, column }));
    setBusy(null);
  };
  const saveEdit = async () => {
    setBusy("edit");
    const result = await attempt(
      rpc.call("task_edit", { id: task.id, title: title.trim() || undefined, description }),
    );
    setBusy(null);
    if (result) setEditing(false);
  };
  const sendFeedback = async () => {
    if (!feedback.trim() || voiceActive) return;
    setBusy("feedback");
    const result = await attempt(
      rpc.call("task_request_changes", { id: task.id, feedback, startOver }),
    );
    setBusy(null);
    if (result) {
      setFeedback("");
      setStartOver(false);
      toast.success(startOver ? "Started a new attempt" : "Sent the changes to the agent");
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${task.title}"? Its thread stays in bb.`)) return;
    setBusy("delete");
    const result = await attempt(rpc.call("task_delete", { id: task.id }));
    setBusy(null);
    if (result) onClose();
  };

  const openThread = task.threadId
    ? () => {
        onClose();
        navigate.toThread(task.threadId as string);
      }
    : null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="pr-6">
          {editing ? (
            <Input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" />
          ) : (
            <DialogTitle className="text-base leading-snug">{task.title}</DialogTitle>
          )}
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{COLUMN_LABELS[task.column]}</span>
            {label ? (
              <>
                <span aria-hidden>·</span>
                <span className={cn(task.error || task.reviewReason === "errors" ? "text-destructive" : undefined)}>
                  {label}
                </span>
              </>
            ) : null}
            {task.branch ? (
              <>
                <span aria-hidden>·</span>
                <code className="text-xs">{task.branch}</code>
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          {openThread ? (
            <Button size="sm" variant="outline" onClick={openThread}>
              <Icon name="MessageCirclePlus" className="size-4" />
              Open thread
            </Button>
          ) : null}
          {task.column === "planning" ? (
            <>
              <Button size="sm" onClick={() => void act("start")} disabled={busy !== null}>
                <Icon name="Play" className="size-4" />
                Queue
              </Button>
              <Button size="sm" variant="outline" onClick={() => void move("in_progress")} disabled={busy !== null}>
                Run now
              </Button>
            </>
          ) : null}
          {task.column === "queue" && !running ? (
            <>
              <Button size="sm" onClick={() => void move("in_progress")} disabled={busy !== null}>
                <Icon name="Play" className="size-4" />
                Run now
              </Button>
              <Button size="sm" variant="outline" onClick={() => void move("planning")} disabled={busy !== null}>
                Back to Planning
              </Button>
            </>
          ) : null}
          {running ? (
            <Button size="sm" variant="outline" onClick={() => void act("stop")} disabled={busy !== null}>
              <Icon name="Square" className="size-4" />
              Stop
            </Button>
          ) : null}
          {inReview && !running ? (
            <>
              {task.pullRequest ? (
                <>
                  <Button size="sm" onClick={() => void act("merge")} disabled={busy !== null}>
                    <Icon name="GitMerge" className="size-4" />
                    Merge PR
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => navigate.openUrl(task.pullRequest?.url ?? "")}>
                    <Icon name="ExternalLink" className="size-4" />
                    PR #{task.pullRequest.number}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void act("refresh_pr")} disabled={busy !== null}>
                    Refresh PR
                  </Button>
                  {task.pullRequest.attention === "conflicts" ? (
                    <Button size="sm" variant="outline" onClick={() => void act("resolve_conflicts")} disabled={busy !== null}>
                      Resolve conflicts
                    </Button>
                  ) : null}
                </>
              ) : task.threadId ? (
                <Button size="sm" onClick={() => void act("create_pr")} disabled={busy !== null}>
                  <Icon name="GitPullRequest" className="size-4" />
                  Create PR
                </Button>
              ) : null}
              {task.threadId ? (
                <Button size="sm" variant="ghost" onClick={() => void act("retry_validation")} disabled={busy !== null}>
                  Validate again
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => void act("done")} disabled={busy !== null}>
                <Icon name="Check" className="size-4" />
                Mark done
              </Button>
            </>
          ) : null}
          {task.column === "done" ? (
            <Button size="sm" variant="outline" onClick={() => void move("human_review")} disabled={busy !== null}>
              Reopen
            </Button>
          ) : null}
        </div>

        {task.error ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {task.error}
          </p>
        ) : null}

        {inReview && !running && task.threadId ? (
          <Section title="Request changes">
            <VoiceInputTextarea
              value={feedback}
              onValueChange={setFeedback}
              onVoiceInputActiveChange={setVoiceActive}
              placeholder="What should the agent change? It continues in the same session."
              className={textareaClass}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void sendFeedback();
                }
              }}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={startOver} onCheckedChange={(checked) => setStartOver(checked === true)} />
                Discard this attempt and start over
              </label>
              <Button
                size="sm"
                onClick={() => void sendFeedback()}
                disabled={!feedback.trim() || voiceActive || busy !== null}
              >
                Send changes
              </Button>
            </div>
          </Section>
        ) : null}

        {task.report ? (
          <Section
            title="Validation"
            aside={
              <Chip tone={task.report.status === "passed" ? "good" : task.report.status === "failed" ? "bad" : "warn"}>
                {task.report.status}
              </Chip>
            }
          >
            <Markdown content={task.report.summary} className="text-sm" />
            {task.report.checks.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {task.report.checks.map((check, index) => (
                  <li key={`${check.name}-${index}`} className="flex items-start gap-2">
                    <Icon
                      name={check.passed ? "Check" : "X"}
                      aria-label={check.passed ? "Passed" : "Failed"}
                      className={cn("mt-0.5 size-4 shrink-0", check.passed ? "text-primary" : "text-destructive")}
                    />
                    <span className="min-w-0">
                      {check.name}
                      {check.command ? <code className="ml-1.5 text-xs text-muted-foreground">{check.command}</code> : null}
                      {check.details ? <span className="block text-xs text-muted-foreground">{check.details}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {task.report.findings.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {task.report.findings.map((finding, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <Chip tone={finding.fixed ? "muted" : finding.severity === "minor" ? "warn" : "bad"}>
                      {finding.severity}
                      {finding.fixed ? " · fixed" : ""}
                    </Chip>
                    <span className="min-w-0">{finding.description}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        ) : null}

        <Section
          title="Task"
          aside={
            !running && !editing ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => {
                  setTitle(task.title);
                  setDescription(task.description);
                  setEditing(true);
                }}
              >
                <Icon name="Pencil" className="size-3.5" />
                Edit
              </Button>
            ) : null
          }
        >
          {editing ? (
            <div className="space-y-2">
              <VoiceInputTextarea value={description} onValueChange={setDescription} className={textareaClass} />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void saveEdit()} disabled={busy !== null}>
                  Save
                </Button>
              </div>
            </div>
          ) : task.description ? (
            <Markdown content={task.description} className="text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
        </Section>

        {task.triage ? (
          <Section title="Triage">
            <div className="flex flex-wrap gap-1">
              <Chip>{task.triage.tier}</Chip>
              {task.triage.model ? <Chip>{task.triage.model}</Chip> : null}
              <Chip>{task.triage.reasoningLevel ?? task.triage.effort} effort</Chip>
              <Chip>{task.triage.scope}</Chip>
              <Chip>{task.triage.needsPlan ? "plan first" : "no plan"}</Chip>
            </div>
            {task.triage.reasoning ? <p className="text-sm text-muted-foreground">{task.triage.reasoning}</p> : null}
            {task.triage.verification.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Checks:{" "}
                {task.triage.verification.map((command, index) => (
                  <code key={index} className="mr-1.5">
                    {command}
                  </code>
                ))}
              </p>
            ) : null}
          </Section>
        ) : null}

        {task.changedFiles.length > 0 ? (
          <Section title={`Changed files (${task.changedFiles.length})`}>
            <ul className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs">
              {task.changedFiles.map((file) => (
                <li key={file} className="truncate py-0.5">
                  {file}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {events.length > 0 ? (
          <Section title="Activity">
            <ol className="space-y-1.5 text-sm">
              {[...events].reverse().map((event) => (
                <li key={event.id} className="flex gap-3">
                  <span className="w-16 shrink-0 text-xs leading-5 text-muted-foreground" title={new Date(event.at).toLocaleString()}>
                    {relativeTime(event.at)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0",
                      event.kind === "error" && "text-destructive",
                      event.kind === "warning" && "text-muted-foreground",
                    )}
                  >
                    {event.message}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        ) : null}

        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
          {task.threadId && task.column !== "done" ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => {
                if (window.confirm("Discard this attempt? The thread is archived and the task goes back to Planning.")) {
                  void act("discard");
                }
              }}
              disabled={busy !== null}
            >
              Discard attempt
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => void remove()}
            disabled={busy !== null}
          >
            <Icon name="Trash2" className="size-4" />
            Delete task
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
