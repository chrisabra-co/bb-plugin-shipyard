import { useState } from "react";
import { experimental_VoiceInputTextarea as VoiceInputTextarea } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PLAN_MODES, PLAN_MODE_LABELS, type PlanMode } from "../constants";
import type { Lesson, StageSkills } from "../model";
import { Segmented, type ShipyardRpc, attempt, textareaClass } from "./shared";
import { TaskSkillsEditor, useSkills } from "./skills";

type Destination = "ideas" | "brainstorm" | "queue";

const DESTINATIONS: readonly { value: Destination; label: string }[] = [
  { value: "queue", label: "Queue" },
  { value: "brainstorm", label: "Brainstorm" },
  { value: "ideas", label: "Ideas" },
];

const DESTINATION_TEXT: Record<Destination, { hint: string; submit: string }> = {
  queue: { hint: "An agent starts when a slot is free.", submit: "Create and queue" },
  brainstorm: { hint: "An agent asks you questions in its thread and writes the spec with you.", submit: "Start brainstorm" },
  ideas: { hint: "Saved for later. Nothing runs.", submit: "Save idea" },
};

export function NewTaskDialog({
  open,
  projectId,
  rpc,
  onClose,
}: {
  open: boolean;
  projectId: string;
  rpc: ShipyardRpc;
  onClose: () => void;
}) {
  const skills = useSkills(rpc, projectId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [destination, setDestination] = useState<Destination>("queue");
  const [planMode, setPlanMode] = useState<PlanMode>("auto");
  const [stageSkills, setStageSkills] = useState<StageSkills>({});
  const [showSkills, setShowSkills] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [pending, setPending] = useState(false);

  const canSubmit = (title.trim() !== "" || description.trim() !== "") && !voiceActive && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    const created = await attempt(
      rpc.call("task_create", {
        projectId,
        title: title.trim() || undefined,
        description,
        destination,
        planMode,
        stageSkills,
      }),
    );
    setPending(false);
    if (created) {
      setTitle("");
      setDescription("");
      setPlanMode("auto");
      setStageSkills({});
      setShowSkills(false);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            An agent works in its own git worktree. Nothing reaches your branch until you review it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Title (optional; triage writes one)"
              aria-label="Title"
            />
            <VoiceInputTextarea
              value={description}
              onValueChange={setDescription}
              onVoiceInputActiveChange={setVoiceActive}
              placeholder="Describe the goal, the constraints, and how you will know it is done."
              aria-label="Description"
              className={cn(textareaClass, "min-h-36")}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Send to</p>
              <Segmented<Destination> label="Send to" value={destination} options={DESTINATIONS} onChange={setDestination} />
              <p className="text-xs text-muted-foreground">{DESTINATION_TEXT[destination].hint}</p>
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Plan first</p>
              <Segmented<PlanMode>
                label="Plan first"
                value={planMode}
                options={PLAN_MODES.map((mode) => ({ value: mode, label: PLAN_MODE_LABELS[mode] }))}
                onChange={setPlanMode}
              />
              <p className="text-xs text-muted-foreground">
                {planMode === "auto"
                  ? "Follows the project setting."
                  : planMode === "always"
                    ? "Plan before any change."
                    : "Skip the plan. Good for small, clear tasks."}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <button
              type="button"
              aria-expanded={showSkills}
              onClick={() => setShowSkills((value) => !value)}
              className="inline-flex items-center gap-1 rounded text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon
                name="ChevronRight"
                aria-hidden
                className={cn("size-4 text-muted-foreground motion-safe:transition-transform", showSkills && "rotate-90")}
              />
              Skills for this task
              {Object.keys(stageSkills).length > 0 ? (
                <span className="font-normal text-muted-foreground">
                  ({Object.values(stageSkills).reduce((sum, list) => sum + (list?.length ?? 0), 0)})
                </span>
              ) : null}
            </button>
            {showSkills ? (
              <div className="space-y-2 pl-5">
                <p className="text-xs text-muted-foreground">These add to the project's skills for each stage.</p>
                <TaskSkillsEditor value={stageSkills} onChange={setStageSkills} suggestions={skills} />
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {DESTINATION_TEXT[destination].submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LessonsDialog({
  open,
  projectId,
  lessons,
  rpc,
  onClose,
}: {
  open: boolean;
  projectId: string;
  lessons: Lesson[];
  rpc: ShipyardRpc;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);

  const add = async () => {
    if (!text.trim() || pending) return;
    setPending(true);
    const lesson = await attempt(rpc.call("lesson_add", { projectId, text }));
    setPending(false);
    if (lesson) setText("");
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Lessons</DialogTitle>
          <DialogDescription>
            Every task in this project receives these preferences. Agents add lessons when your feedback shows a
            lasting preference.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="For example: Use pnpm, never npm."
            aria-label="New lesson"
          />
          <Button type="submit" disabled={!text.trim() || pending}>
            Add
          </Button>
        </form>
        {lessons.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No lessons yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {lessons.map((lesson) => (
              <li key={lesson.id} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  {lesson.text}
                  <span className="block text-xs text-muted-foreground">
                    {lesson.source === "user" ? "Added by you" : `From ${lesson.source}`}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Remove lesson: ${lesson.text}`}
                  onClick={() => void attempt(rpc.call("lesson_delete", { id: lesson.id }))}
                >
                  <Icon name="Trash2" className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
