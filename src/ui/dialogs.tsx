import { useState } from "react";
import { experimental_VoiceInputTextarea as VoiceInputTextarea } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { Lesson } from "../model";
import { type ShipyardRpc, attempt } from "./shared";

const textareaClass =
  "min-h-36 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

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
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [start, setStart] = useState(true);
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
        start,
      }),
    );
    setPending(false);
    if (created) {
      setTitle("");
      setDescription("");
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            An agent does the work in its own git worktree. Nothing reaches your branch until you review it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
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
            className={textareaClass}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={start} onCheckedChange={(checked) => setStart(checked === true)} />
            Queue it now
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {start ? "Create and queue" : "Create"}
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
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No lessons yet.
          </p>
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
