// The task's details beside the board: the work to review first, then the
// decision in a bar below it; the live thread, the task itself, and its
// activity in tabs. On a narrow page it takes the full width.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Markdown,
  ThreadChat,
  experimental_VoiceInputTextarea as VoiceInputTextarea,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { COLUMN_LABELS, PLAN_MODES, PLAN_MODE_LABELS, RUNNING_PHASES, type PlanMode, shortModelName } from "../constants";
import type { Task, TaskEvent } from "../model";
import { Segmented, type ShipyardRpc, Spinner, attempt, relativeTime, textareaClass } from "./shared";
import { TaskSkillsEditor, useSkills } from "./skills";
import { StageTrack, StatusLine } from "./TaskCard";
import { taskActions, useActionRunner } from "./actions";

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function hasReview(task: Task): boolean {
  return task.column === "human_review" || task.report !== null || task.plan !== null || task.error !== null;
}

export function TaskPanel({
  task,
  projectId,
  rpc,
  threadActive,
  onClose,
  fill,
}: {
  task: Task | null;
  projectId: string;
  rpc: ShipyardRpc;
  threadActive: boolean;
  onClose: () => void;
  /** Take the page's full width; the board hides behind it. */
  fill: boolean;
}) {
  if (!task) return null;
  return (
    <aside
      aria-label={`Task: ${task.title}`}
      className={cn(
        "flex h-full flex-col bg-background",
        fill ? "w-full min-w-0" : "w-[440px] shrink-0 border-l border-border",
      )}
    >
      <PanelBody task={task} projectId={projectId} rpc={rpc} threadActive={threadActive} onClose={onClose} fill={fill} />
    </aside>
  );
}

type Tab = "review" | "thread" | "task" | "activity";

function asking(task: Task): boolean {
  return (task.reviewReason === "blocked" || task.reviewReason === "needs_input") && task.signal !== null;
}

function defaultTab(task: Task): Tab {
  // A brainstorm happens in the thread; everything else starts on the review.
  if (task.phase === "brainstorm" && task.threadId) return "thread";
  return hasReview(task) ? "review" : "task";
}

function PanelBody({
  task,
  projectId,
  rpc,
  threadActive,
  onClose,
  fill,
}: {
  task: Task;
  projectId: string;
  rpc: ShipyardRpc;
  threadActive: boolean;
  onClose: () => void;
  fill: boolean;
}) {
  const navigate = useBbNavigate();
  const [tab, setTab] = useState<Tab>(defaultTab(task));

  useEffect(() => {
    setTab(defaultTab(task));
    // Only a different task resets the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const running = RUNNING_PHASES.has(task.phase);
  const tabs: [Tab, string][] = [
    ["review", "Review"],
    ...(task.threadId ? ([["thread", "Thread"]] as [Tab, string][]) : []),
    ["task", "Task"],
    ["activity", "Activity"],
  ];
  const activeTab = tab === "thread" && !task.threadId ? "review" : tab;

  return (
    <>
      <header className="space-y-2 border-b border-border px-5 pb-3 pt-3.5">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-xs text-muted-foreground">{COLUMN_LABELS[task.column]}</p>
            <h2 className="text-base font-medium leading-snug text-foreground">{task.title}</h2>
          </div>
          {task.threadId ? (
            <IconButton
              label="Open the thread beside the board"
              icon="SideChat"
              onClick={() => navigate.toThread(task.threadId as string, { split: true })}
            />
          ) : null}
          <IconButton label={fill ? "Back to the board (Esc)" : "Close (Esc)"} icon="X" onClick={onClose} />
        </div>
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <StatusLine task={task} threadActive={threadActive} />
          </div>
          <div className="w-40 shrink-0">
            <StageTrack task={task} compact />
          </div>
        </div>
      </header>

      <div role="tablist" aria-label="Task details" className="flex shrink-0 gap-1 border-b border-border px-4">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            id={`shipyard-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={activeTab === value}
            aria-controls="shipyard-tabpanel"
            onClick={() => setTab(value)}
            className={cn(
              "-mb-px h-10 border-b-2 px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
              activeTab === value
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "thread" && task.threadId ? (
        <div
          id="shipyard-tabpanel"
          role="tabpanel"
          aria-labelledby="shipyard-tab-thread"
          className="flex min-h-0 flex-1 flex-col"
        >
          {task.column === "human_review" && !running ? (
            <p className="shrink-0 border-b border-border px-5 py-2 text-xs text-muted-foreground">
              A message here goes to the agent but does not move the task. To{" "}
              {asking(task) ? "answer and continue the stage" : task.reviewReason === "plan_ready" ? "revise the plan" : "request changes"}, use
              the Review tab.
            </p>
          ) : null}
          <div className="min-h-0 flex-1">
            <ThreadChat threadId={task.threadId} variant="compact" layout="contained" />
          </div>
        </div>
      ) : (
        <div
          id="shipyard-tabpanel"
          role="tabpanel"
          aria-labelledby={`shipyard-tab-${activeTab}`}
          className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5"
        >
          {activeTab === "review" ? <ReviewContent task={task} running={running} /> : null}
          {activeTab === "task" ? (
            <TaskTab task={task} projectId={projectId} rpc={rpc} running={running} onClose={onClose} />
          ) : null}
          {activeTab === "activity" ? <ActivityTab task={task} rpc={rpc} /> : null}
        </div>
      )}

      {activeTab === "thread" ? null : <DecisionBar task={task} rpc={rpc} running={running} />}
    </>
  );
}

function IconButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label={label} onClick={onClick}>
            <Icon name={icon} className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The decision, below what it decides on: the task's actions, and a reply to
 * the agent (changes, a plan change, or an answer). The primary action sits
 * last, at the right edge.
 */
function DecisionBar({ task, rpc, running }: { task: Task; rpc: ShipyardRpc; running: boolean }) {
  const { busy, run } = useActionRunner(rpc, task);
  const [writing, setWriting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [startOver, setStartOver] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [sending, setSending] = useState(false);

  const planReview = task.reviewReason === "plan_ready";
  const asked = asking(task);
  // Plan changes and answers continue the session; only a review can start over.
  const canStartOver = !planReview && !asked;
  const canReply = task.column === "human_review" && !running && task.threadId !== null && task.triage !== null;
  // An answer is the one thing an asking task waits for, so its box is open.
  const open = canReply && (writing || asked);
  const copy = asked
    ? { toggle: "Answer", placeholder: "Your answer. The agent continues the stage in the same session.", button: "Send answer" }
    : planReview
      ? { toggle: "Change the plan", placeholder: "What should change in the plan? The agent revises it before any code.", button: "Revise the plan" }
      : { toggle: "Request changes", placeholder: "What should the agent change? It continues in the same session.", button: "Send changes" };

  useEffect(() => {
    setWriting(false);
    setFeedback("");
    setStartOver(false);
  }, [task.id]);

  const send = async () => {
    if (!feedback.trim() || voiceActive || sending) return;
    setSending(true);
    const result = await attempt(
      rpc.call("task_request_changes", { id: task.id, feedback, startOver: canStartOver && startOver }),
    );
    setSending(false);
    if (result) {
      setFeedback("");
      setStartOver(false);
      setWriting(false);
      toast.success(
        canStartOver && startOver ? "Queued a new attempt" : asked ? "Sent your answer to the agent" : "Sent your changes to the agent",
      );
    }
  };

  const actions = taskActions(task).filter((action) => action.id !== "thread");
  const ordered = [...actions.filter((action) => action.weight !== "primary"), ...actions.filter((action) => action.weight === "primary")];
  if (actions.length === 0 && !canReply) return null;

  return (
    <footer className="shrink-0 space-y-3 border-t border-border px-4 py-3">
      {open ? (
        <div className="space-y-2">
          <VoiceInputTextarea
            value={feedback}
            onValueChange={setFeedback}
            onVoiceInputActiveChange={setVoiceActive}
            placeholder={copy.placeholder}
            aria-label={copy.toggle}
            className={cn(textareaClass, "min-h-20")}
            autoFocus={!asked}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
              if (event.key === "Escape" && !asked) {
                event.stopPropagation();
                setWriting(false);
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {canStartOver ? (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={startOver} onCheckedChange={(checked) => setStartOver(checked === true)} />
                Discard this attempt and start over
              </label>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              {asked ? null : (
                <Button size="sm" variant="ghost" onClick={() => setWriting(false)}>
                  Cancel
                </Button>
              )}
              <Button
                size="sm"
                variant={asked ? "default" : "outline"}
                onClick={() => void send()}
                disabled={!feedback.trim() || voiceActive || sending}
              >
                {copy.button}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {ordered.length > 0 || (canReply && !open) ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canReply && !open ? (
            <Button size="sm" variant="outline" className="mr-auto" onClick={() => setWriting(true)}>
              <Icon name="Edit" className="size-4" />
              {copy.toggle}
            </Button>
          ) : null}
          {ordered.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.weight === "primary" ? (asked ? "outline" : "default") : action.weight === "secondary" ? "outline" : "ghost"}
              onClick={() => void run(action)}
              disabled={busy !== null}
            >
              {busy === action.id ? <Spinner /> : action.icon ? <Icon name={action.icon} className="size-4" /> : null}
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </footer>
  );
}

/** What the user reviews: the agent's question, the plan, the report, the files. */
function ReviewContent({ task, running }: { task: Task; running: boolean }) {
  const asked = asking(task);
  const empty = !task.error && !asked && !task.report && !task.plan && task.changedFiles.length === 0;

  return (
    <>
      {task.error ? (
        <p role="alert" className="rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive">
          {task.error}
        </p>
      ) : null}

      {asked && task.signal ? (
        <section className="space-y-1.5 rounded-md border border-border px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Icon name="AlertTriangle" aria-hidden className="size-4 text-primary" />
            {task.reviewReason === "blocked" ? "The agent is blocked" : "The agent needs your input"}
          </p>
          <Markdown content={task.signal.summary} className="text-sm" />
        </section>
      ) : null}

      {task.plan && task.reviewReason === "plan_ready" ? (
        <Section title="Plan">
          <Markdown content={task.plan} className="text-sm" />
        </Section>
      ) : null}

      {task.report ? (
        <Section
          title="Validation"
          aside={
            <span
              className={cn(
                "text-xs",
                task.report.status === "failed" ? "text-destructive" : task.report.status === "passed" ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {task.report.status === "passed" ? "Passed" : task.report.status === "failed" ? "Failed" : "Partial"}
            </span>
          }
        >
          <Markdown content={task.report.summary} className="text-sm" />
          {task.report.checks.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
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
            <ul className="space-y-2 text-sm">
              {task.report.findings.map((finding, index) => (
                <li key={index} className="space-y-0.5">
                  <span
                    className={cn(
                      "block text-xs",
                      finding.fixed ? "text-muted-foreground" : finding.severity === "minor" ? "text-foreground" : "text-destructive",
                    )}
                  >
                    {finding.severity === "critical" ? "Critical" : finding.severity === "major" ? "Major" : "Minor"}
                    {finding.fixed ? ", fixed" : ""}
                  </span>
                  <span className="block">{finding.description}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {task.plan && task.reviewReason !== "plan_ready" ? (
        <Section title="Plan">
          <Markdown content={task.plan} className="text-sm" />
        </Section>
      ) : null}

      {task.changedFiles.length > 0 ? (
        <Section title={`Changed files (${task.changedFiles.length})`}>
          <ul className="max-h-48 overflow-y-auto font-mono text-xs text-muted-foreground">
            {task.changedFiles.map((file) => (
              <li key={file} className="truncate py-0.5">
                {file}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {empty ? (
        <p className="text-sm text-muted-foreground">
          {running ? "The agent is working. " : ""}Nothing to review yet. The plan, the validation report, and the changed files show here when the agent has
          them.
        </p>
      ) : null}
    </>
  );
}

function TaskTab({
  task,
  projectId,
  rpc,
  running,
  onClose,
}: {
  task: Task;
  projectId: string;
  rpc: ShipyardRpc;
  running: boolean;
  onClose: () => void;
}) {
  const skills = useSkills(rpc, projectId);
  const [removing, setRemoving] = useState(false);

  const discard = async () => {
    if (!window.confirm("Discard this attempt? The thread is archived and the task goes back to Ideas.")) return;
    setRemoving(true);
    await attempt(rpc.call("task_action", { id: task.id, action: "discard" }));
    setRemoving(false);
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${task.title}"? Its thread stays in bb.`)) return;
    setRemoving(true);
    const result = await attempt(rpc.call("task_delete", { id: task.id }));
    setRemoving(false);
    if (result) onClose();
  };
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  // Local copy, so a second quick edit builds on the first before the board refetches.
  const [stageSkills, setStageSkills] = useState(task.stageSkills);

  useEffect(() => setEditing(false), [task.id]);
  useEffect(() => setStageSkills(task.stageSkills), [task.id, task.updatedAt]);

  const save = async () => {
    setSaving(true);
    const result = await attempt(rpc.call("task_edit", { id: task.id, title: title.trim(), description }));
    setSaving(false);
    if (result) setEditing(false);
  };

  return (
    <>
      <Section
        title="Description"
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
              <Icon name="Edit" className="size-3.5" />
              Edit
            </Button>
          ) : null
        }
      >
        {editing ? (
          <div className="space-y-2">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" />
            <VoiceInputTextarea value={description} onValueChange={setDescription} className={textareaClass} aria-label="Description" />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving || !title.trim()}>
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

      <Section title="Plan first">
        <Segmented<PlanMode>
          label="Plan first"
          value={task.planMode}
          options={PLAN_MODES.map((mode) => ({ value: mode, label: PLAN_MODE_LABELS[mode] }))}
          onChange={(planMode) => void attempt(rpc.call("task_edit", { id: task.id, planMode }))}
        />
        <p className="text-xs text-muted-foreground">
          {task.planMode === "auto"
            ? "Follows the project setting; triage decides when the setting is automatic."
            : task.planMode === "always"
              ? "The agent writes a plan before any change."
              : "The agent goes straight to the change. Good for small, clear tasks."}
        </p>
      </Section>

      <Section title="Skills for this task">
        <p className="text-xs text-muted-foreground">These add to the project's skills for each stage.</p>
        <TaskSkillsEditor
          value={stageSkills}
          suggestions={skills}
          onChange={(next) => {
            setStageSkills(next);
            void attempt(rpc.call("task_edit", { id: task.id, stageSkills: next }));
          }}
        />
      </Section>

      {task.triage ? (
        <Section title="Triage">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Model</dt>
            <dd>{shortModelName(task.triage.model) ?? "Provider default"}</dd>
            <dt className="text-muted-foreground">Effort</dt>
            <dd className="capitalize">{task.triage.reasoningLevel ?? task.triage.effort}</dd>
            <dt className="text-muted-foreground">Scope</dt>
            <dd className="capitalize">{task.triage.scope}</dd>
            <dt className="text-muted-foreground">Plan</dt>
            <dd>{task.triage.needsPlan ? "Recommended" : "Not needed"}</dd>
          </dl>
          {task.triage.reasoning ? <p className="text-sm text-muted-foreground">{task.triage.reasoning}</p> : null}
          {task.triage.verification.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {task.triage.verification.map((command, index) => (
                <li key={index}>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{command}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {task.branch ? (
        <Section title="Branch">
          <code className="text-xs text-muted-foreground">{task.branch}</code>
        </Section>
      ) : null}

      {/* Destructive actions sit apart from the decisions in the bar below. */}
      <div className="flex flex-wrap gap-1 border-t border-border pt-4">
        {task.threadId && task.column !== "done" ? (
          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={removing} onClick={() => void discard()}>
            Discard attempt
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => void remove()}
          disabled={removing}
        >
          <Icon name="Trash2" className="size-4" />
          Delete task
        </Button>
      </div>
    </>
  );
}

function ActivityTab({ task, rpc }: { task: Task; rpc: ShipyardRpc }) {
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc.call("task_events", { id: task.id }).then(
      (result) => {
        if (!cancelled) setEvents(result.events);
      },
      () => {
        if (!cancelled) setEvents([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, task.id, task.updatedAt]);

  if (events === null) return null;
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <ol className="space-y-2 text-sm">
      {[...events].reverse().map((event) => (
        <li key={event.id} className="flex gap-3">
          <span className="w-16 shrink-0 text-xs leading-5 text-muted-foreground" title={new Date(event.at).toLocaleString()}>
            {relativeTime(event.at)}
          </span>
          <span className={cn("min-w-0", event.kind === "error" && "text-destructive", event.kind === "warning" && "text-muted-foreground")}>
            {event.message}
          </span>
        </li>
      ))}
    </ol>
  );
}
