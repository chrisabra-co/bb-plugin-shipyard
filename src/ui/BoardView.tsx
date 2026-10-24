import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { COLUMNS, COLUMN_LABELS, type ColumnId } from "../constants";
import type { Task } from "../model";
import { type Board, type ShipyardRpc, attempt } from "./shared";
import { QuickActions } from "./actions";
import { DRAG_TYPE, TaskCard } from "./TaskCard";

export const EMPTY_HINTS: Record<ColumnId, string> = {
  ideas: "Save ideas here. Nothing runs until you queue or brainstorm one.",
  brainstorm: "Drag an idea here to shape it with an agent before anyone builds it.",
  queue: "Tasks start when a slot is free.",
  in_progress: "Agents triage, plan, build, and validate here.",
  human_review: "Finished work and plans wait here for you.",
  done: "Merged and finished tasks.",
};

/** Position for a card dropped before `beforeId`, or at the column's end. */
function dropPosition(cards: Task[], movingId: string, beforeId: string | null): number {
  const others = cards.filter((card) => card.id !== movingId);
  if (others.length === 0) return 1;
  if (beforeId === null) return (others[others.length - 1]?.position ?? 0) + 1;
  const index = others.findIndex((card) => card.id === beforeId);
  if (index <= 0) return (others[0]?.position ?? 1) - 1;
  const before = others[index - 1]?.position ?? 0;
  const after = others[index]?.position ?? before + 2;
  return (before + after) / 2;
}

export function BoardView({
  board,
  byColumn,
  projectId,
  rpc,
  activeThreads,
  selectedId,
  onOpen,
  setBoard,
  refetch,
}: {
  board: Board | null;
  byColumn: Map<ColumnId, Task[]>;
  projectId: string;
  rpc: ShipyardRpc;
  activeThreads: Set<string>;
  selectedId: string | null;
  onOpen: (id: string) => void;
  setBoard: (board: Board) => void;
  refetch: () => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ column: ColumnId; beforeId: string | null } | null>(null);
  const [idea, setIdea] = useState("");

  // The task panel narrows the board; keep the open card in view. Scroll once
  // per opened task, after its card exists (a link can open it before the
  // board loads), so later board updates do not move the view.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || scrolledTo.current === selectedId) return;
    const frame = window.requestAnimationFrame(() => {
      const card = document.querySelector(`[data-task-id="${CSS.escape(selectedId)}"]`);
      if (!card) return;
      scrolledTo.current = selectedId;
      card.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId, board]);

  const move = (id: string, column: ColumnId, position?: number) => {
    if (board) {
      // Show the move at once; the server's answer replaces it.
      setBoard({
        ...board,
        tasks: board.tasks.map((task) =>
          task.id === id ? { ...task, column, position: position ?? task.position } : task,
        ),
      });
    }
    void attempt(rpc.call("task_move", { id, column, ...(position === undefined ? {} : { position }) })).then(
      (result) => {
        // A failed move publishes no change; reload to undo the optimistic one.
        if (!result) refetch();
      },
    );
  };

  const addIdea = async () => {
    const text = idea.trim();
    if (!text) return;
    setIdea("");
    const created = await attempt(rpc.call("task_create", { projectId, description: text, destination: "ideas" }));
    if (!created) setIdea(text);
  };

  const onDragOver = (event: DragEvent<HTMLElement>, column: ColumnId) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-task-id]");
    let beforeId: string | null = null;
    if (card) {
      const rect = card.getBoundingClientRect();
      const id = card.dataset.taskId ?? null;
      if (event.clientY < rect.top + rect.height / 2) beforeId = id;
      else {
        const cards = byColumn.get(column) ?? [];
        const index = cards.findIndex((task) => task.id === id);
        beforeId = cards[index + 1]?.id ?? null;
      }
    }
    if (dropTarget?.column !== column || dropTarget.beforeId !== beforeId) setDropTarget({ column, beforeId });
  };

  const onDrop = (event: DragEvent<HTMLElement>, column: ColumnId) => {
    const id = event.dataTransfer.getData(DRAG_TYPE);
    const target = dropTarget;
    setDropTarget(null);
    setDraggingId(null);
    if (!id) return;
    event.preventDefault();
    move(id, column, dropPosition(byColumn.get(column) ?? [], id, target?.column === column ? target.beforeId : null));
  };

  return (
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
      <div className="flex h-full min-w-fit divide-x divide-border/60 px-1">
        {COLUMNS.map((column) => {
          const cards = byColumn.get(column) ?? [];
          const isTarget = dropTarget?.column === column;
          return (
            <section
              key={column}
              aria-label={COLUMN_LABELS[column]}
              onDragOver={(event) => onDragOver(event, column)}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
              }}
              onDrop={(event) => onDrop(event, column)}
              className={cn(
                "flex h-full min-w-[200px] max-w-96 flex-1 basis-0 flex-col",
                "transition-colors motion-reduce:transition-none",
                isTarget && "bg-primary/[0.04]",
              )}
            >
              <header className="flex h-11 shrink-0 items-center gap-2 px-3">
                <h2 className="text-sm font-medium text-foreground">{COLUMN_LABELS[column]}</h2>
                <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-4">
                {column === "ideas" ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void addIdea();
                    }}
                  >
                    <Input
                      value={idea}
                      onChange={(event) => setIdea(event.target.value)}
                      placeholder="Add an idea and press Enter"
                      aria-label="New idea"
                      className="h-8 bg-transparent text-sm"
                    />
                  </form>
                ) : null}
                {board === null ? null : cards.length === 0 ? (
                  <p className="px-1 py-2 text-xs leading-relaxed text-muted-foreground">{EMPTY_HINTS[column]}</p>
                ) : (
                  cards.map((task) => (
                    <div key={task.id} className="relative">
                      {isTarget && dropTarget?.beforeId === task.id && draggingId !== task.id ? (
                        <div aria-hidden className="absolute -top-1.5 left-1 right-1 h-0.5 rounded bg-primary" />
                      ) : null}
                      <TaskCard
                        task={task}
                        threadActive={task.threadId !== null && activeThreads.has(task.threadId)}
                        dragging={draggingId === task.id}
                        selected={selectedId === task.id}
                        onOpen={() => onOpen(task.id)}
                        onQueue={() => move(task.id, "queue")}
                        onSaveForLater={() => move(task.id, "ideas")}
                        actions={
                          <QuickActions
                            task={task}
                            rpc={rpc}
                            // The brainstorm card shows these two as text buttons.
                            omit={task.column === "brainstorm" ? ["queue", "later"] : undefined}
                          />
                        }
                        onDragStart={() => setDraggingId(task.id)}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDropTarget(null);
                        }}
                      />
                    </div>
                  ))
                )}
                {isTarget && dropTarget?.beforeId === null && cards.length > 0 ? (
                  <div aria-hidden className="mx-1 h-0.5 rounded bg-primary" />
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
