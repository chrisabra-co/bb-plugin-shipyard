import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import {
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { COLUMNS, COLUMN_LABELS, type ColumnId, RUNNING_PHASES } from "../constants";
import type { Task } from "../model";
import { LessonsDialog, NewTaskDialog } from "./dialogs";
import { NativeSelect, attempt, useBoard } from "./shared";
import { DRAG_TYPE, TaskCard } from "./TaskCard";
import { TaskDialog } from "./TaskDialog";

const COLUMN_HINTS: Record<ColumnId, string> = {
  planning: "Draft tasks here. Nothing runs yet.",
  queue: "Starts when a slot is free.",
  in_progress: "Triage, then implementation.",
  ai_review: "Checks and a fresh-eyes review.",
  human_review: "Your turn: review, request changes, or merge.",
  done: "",
};

interface ProjectOption {
  id: string;
  name: string;
}

function useProjects() {
  const sdk = useSdk();
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    sdk.projects.list().then(
      (list) => {
        if (!cancelled) setProjects(list.map((project) => ({ id: project.id, name: project.name })));
      },
      () => {
        if (!cancelled) setProjects([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk]);
  return projects;
}

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

export function BoardPage({ subPath }: { subPath: string }) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const projects = useProjects();
  const storageKey = `${pluginId}:last-project`;

  const routeProjectId = subPath.split("/")[0] || null;
  const projectId = useMemo(() => {
    if (!projects || projects.length === 0) return null;
    const known = (id: string | null | undefined) =>
      id && projects.some((project) => project.id === id) ? id : null;
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(storageKey);
    } catch {
      remembered = null;
    }
    return known(routeProjectId) ?? known(context.projectId) ?? known(remembered) ?? projects[0]?.id ?? null;
  }, [projects, routeProjectId, context.projectId, storageKey]);

  useEffect(() => {
    if (!projectId) return;
    try {
      window.localStorage.setItem(storageKey, projectId);
    } catch {
      // storage is optional
    }
  }, [projectId, storageKey]);

  const { board, setBoard, error, rpc } = useBoard(projectId);
  const { threads } = experimental_useSidebarThreads();
  const activeThreads = useMemo(
    () => new Set(threads.filter((thread) => thread.status === "active").map((thread) => thread.id)),
    [threads],
  );

  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ column: ColumnId; beforeId: string | null } | null>(null);

  const byColumn = useMemo(() => {
    const map = new Map<ColumnId, Task[]>(COLUMNS.map((column) => [column, []]));
    for (const task of board?.tasks ?? []) map.get(task.column)?.push(task);
    for (const cards of map.values()) cards.sort((a, b) => a.position - b.position);
    const done = map.get("done");
    if (done) done.sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
    return map;
  }, [board]);

  const running = board?.tasks.filter((task) => RUNNING_PHASES.has(task.phase) && task.phase !== "pr").length ?? 0;
  const openTask = board?.tasks.find((task) => task.id === openTaskId) ?? null;

  const onDragOverColumn = (event: DragEvent<HTMLElement>, column: ColumnId) => {
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
    if (!id || !board) return;
    event.preventDefault();
    const position = dropPosition(byColumn.get(column) ?? [], id, target?.column === column ? target.beforeId : null);
    // Show the move at once; the server's answer replaces it.
    setBoard({
      ...board,
      tasks: board.tasks.map((task) => (task.id === id ? { ...task, column, position } : task)),
    });
    void attempt(rpc.call("task_move", { id, column, position }));
  };

  if (projects === null) {
    return <CenteredNote>Loading projects…</CenteredNote>;
  }
  if (projects.length === 0 || !projectId) {
    return (
      <CenteredNote>
        Shipyard needs a project with a git repository. Add one in bb, then come back.
      </CenteredNote>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 md:px-5">
        <NativeSelect
          aria-label="Project"
          value={projectId}
          onChange={(event) => navigate.toPluginPanel("board", { subPath: event.target.value })}
          className="w-52"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </NativeSelect>
        {board ? (
          <span className="text-xs text-muted-foreground">
            {running} of {board.maxParallel} running
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setLessonsOpen(true)}>
            <Icon name="Lightbulb" fallback="Star" className="size-4" />
            Lessons{board && board.lessons.length > 0 ? ` (${board.lessons.length})` : ""}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              navigate.toCompose({
                projectId,
                focusPrompt: true,
                initialPrompt:
                  "Look at this project's Shipyard board with `bb shipyard list`, then help me with: ",
              })
            }
          >
            <Icon name="AiContentGenerator01" fallback="MessageCirclePlus" className="size-4" />
            Ask an agent
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Icon name="Plus" className="size-4" />
            New task
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="px-5 pt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-fit gap-3 p-4 md:px-5">
          {COLUMNS.map((column) => {
            const cards = byColumn.get(column) ?? [];
            const isTarget = dropTarget?.column === column;
            return (
              <section
                key={column}
                aria-label={COLUMN_LABELS[column]}
                onDragOver={(event) => onDragOverColumn(event, column)}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
                }}
                onDrop={(event) => onDrop(event, column)}
                className={cn(
                  "flex h-full min-w-52 max-w-96 flex-1 basis-0 flex-col rounded-xl border border-transparent bg-muted/40 transition-colors",
                  isTarget && "border-primary/40 bg-primary/5",
                )}
              >
                <header className="px-3 pb-1 pt-3">
                  <div className="flex h-6 items-center gap-2">
                    <h2 className="text-sm font-medium text-foreground">{COLUMN_LABELS[column]}</h2>
                    <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
                    {column === "planning" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-auto size-6 text-muted-foreground"
                        aria-label="New task"
                        onClick={() => setCreating(true)}
                      >
                        <Icon name="Plus" className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                  {COLUMN_HINTS[column] ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{COLUMN_HINTS[column]}</p>
                  ) : null}
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {board === null ? null : cards.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                      {column === "planning" ? "Add a task to get started." : "Drop a task here."}
                    </div>
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
                          onOpen={() => setOpenTaskId(task.id)}
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

      <NewTaskDialog open={creating} projectId={projectId} rpc={rpc} onClose={() => setCreating(false)} />
      <LessonsDialog
        open={lessonsOpen}
        projectId={projectId}
        lessons={board?.lessons ?? []}
        rpc={rpc}
        onClose={() => setLessonsOpen(false)}
      />
      <TaskDialog task={openTask} rpc={rpc} onClose={() => setOpenTaskId(null)} />
    </div>
  );
}

function CenteredNote({ children }: { children: string }) {
  return (
    <div className="flex h-full flex-1 items-center justify-center p-6">
      <p className="max-w-sm text-center text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
