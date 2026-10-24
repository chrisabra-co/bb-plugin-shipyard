// The Shipyard page: one project's tasks as a board or a list, the task
// panel, and the settings. Routes: <projectId>, <projectId>/board,
// <projectId>/list, <projectId>/settings, and settings.
import { useEffect, useMemo, useState } from "react";
import {
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { COLUMNS, type ColumnId, RUNNING_PHASES } from "../constants";
import type { Task } from "../model";
import { BoardView } from "./BoardView";
import { LessonsDialog, NewTaskDialog } from "./dialogs";
import { ListView } from "./ListView";
import { SettingsView } from "./SettingsView";
import { NativeSelect, Segmented, useBoard, useProjects, useElementWidth } from "./shared";
import { TaskPanel } from "./TaskPanel";

type View = "board" | "list" | "settings";
const VIEWS: readonly View[] = ["board", "list", "settings"];

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage is optional
  }
}

export function BoardPage({ subPath }: { subPath: string }) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const projects = useProjects();
  const projectKey = `${pluginId}:last-project`;
  const viewKey = `${pluginId}:view`;

  // "settings" alone opens the settings of the last project.
  const [routeProjectId, routeView, routeTaskKey, routeTaskId] =
    subPath === "settings" ? [undefined, "settings"] : subPath.split("/");
  const projectId = useMemo(() => {
    if (!projects || projects.length === 0) return null;
    const known = (id: string | null | undefined) =>
      id && projects.some((project) => project.id === id) ? id : null;
    return known(routeProjectId) ?? known(context.projectId) ?? known(readStorage(projectKey)) ?? projects[0]?.id ?? null;
  }, [projects, routeProjectId, context.projectId, projectKey]);
  const remembered = readStorage(viewKey) === "list" ? "list" : "board";
  const view: View = VIEWS.includes(routeView as View) ? (routeView as View) : remembered;

  useEffect(() => {
    if (projectId) writeStorage(projectKey, projectId);
  }, [projectId, projectKey]);

  const go = (nextProject: string, nextView: View) => {
    if (nextView !== "settings") writeStorage(viewKey, nextView);
    navigate.toPluginPanel("board", { subPath: `${nextProject}/${nextView}` });
  };

  // The open task lives in the URL, so a reload keeps it, a link can share
  // it, and Back closes it.
  const openTaskId = view !== "settings" && routeTaskKey === "task" && routeTaskId ? routeTaskId : null;
  const openTaskRoute = (id: string | null, options: { replace?: boolean } = {}) => {
    if (!projectId) return;
    navigate.toPluginPanel("board", {
      subPath: id ? `${projectId}/${view}/task/${id}` : `${projectId}/${view}`,
      ...options,
    });
  };
  const setOpenTaskId = (id: string | null) => openTaskRoute(id);

  const { board, setBoard, error, rpc, refetch } = useBoard(projectId);
  const { threads } = experimental_useSidebarThreads();
  const activeThreads = useMemo(
    () => new Set(threads.filter((thread) => thread.status === "active").map((thread) => thread.id)),
    [threads],
  );

  const [creating, setCreating] = useState(false);
  const [lessonsOpen, setLessonsOpen] = useState(false);


  const byColumn = useMemo(() => {
    const map = new Map<ColumnId, Task[]>(COLUMNS.map((column) => [column, []]));
    for (const task of board?.tasks ?? []) map.get(task.column)?.push(task);
    for (const cards of map.values()) cards.sort((a, b) => a.position - b.position);
    map.get("done")?.sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
    return map;
  }, [board]);

  const running =
    board?.tasks.filter((task) => RUNNING_PHASES.has(task.phase) && task.phase !== "pr").length ?? 0;
  const openTask = board?.tasks.find((task) => task.id === openTaskId) ?? null;
  const [measureRow, rowWidth] = useElementWidth<HTMLDivElement>();
  const fill = rowWidth !== null && rowWidth < 960;

  // Esc closes the open task; Up and Down (or k and j) move through its column.
  useEffect(() => {
    if (!openTask) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        openTaskRoute(null);
        return;
      }
      const step = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
      if (step === 0) return;
      const cards = byColumn.get(openTask.column) ?? [];
      const next = cards[cards.findIndex((card) => card.id === openTask.id) + step];
      if (!next) return;
      event.preventDefault();
      openTaskRoute(next.id, { replace: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (projects === null) return <CenteredNote>Loading projects…</CenteredNote>;
  if (projects.length === 0 || !projectId) {
    return <CenteredNote>Shipyard needs a project with a git repository. Add one in bb, then come back.</CenteredNote>;
  }
  const projectName = projects.find((project) => project.id === projectId)?.name ?? "This project";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 md:px-5">
        <NativeSelect
          aria-label="Project"
          value={projectId}
          onChange={(event) => go(event.target.value, view)}
          className="w-48"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </NativeSelect>
        {view !== "settings" ? (
          <Segmented<"board" | "list">
            label="View"
            value={view}
            options={[
              { value: "board", label: "Board", icon: "Columns2" },
              { value: "list", label: "List", icon: "ListView" },
            ]}
            onChange={(next) => go(projectId, next)}
          />
        ) : null}
        {board && view !== "settings" ? (
          <span className="px-1 text-xs tabular-nums text-muted-foreground">
            {running} of {board.maxParallel} running
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setLessonsOpen(true)}>
            <Icon name="Brain" className="size-4" />
            Lessons{board && board.lessons.length > 0 ? ` (${board.lessons.length})` : ""}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              navigate.toCompose({
                projectId,
                focusPrompt: true,
                initialPrompt: "Look at this project's Shipyard board with `bb shipyard list`, then help me with: ",
              })
            }
          >
            <Icon name="Bot" className="size-4" />
            Ask an agent
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view === "settings"}
            onClick={() => go(projectId, view === "settings" ? remembered : "settings")}
          >
            <Icon name="Settings" className="size-4" />
            Settings
          </Button>
          {view !== "settings" ? (
            <Button size="sm" className="ml-1" onClick={() => setCreating(true)}>
              <Icon name="Plus" className="size-4" />
              New task
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="px-5 pt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {view === "settings" ? (
        <SettingsView
          projectId={projectId}
          projectName={projectName}
          rpc={rpc}
          onBack={() => go(projectId, remembered)}
        />
      ) : (
        <div ref={measureRow} className="flex min-h-0 flex-1">
          {/* On a narrow page (a small window or a split), the task takes the full width. */}
          <div className={openTask && fill ? "hidden" : "flex min-w-0 flex-1 flex-col"}>
            {view === "board" ? (
              <BoardView
                board={board}
                byColumn={byColumn}
                projectId={projectId}
                rpc={rpc}
                activeThreads={activeThreads}
                selectedId={openTaskId}
                onOpen={setOpenTaskId}
                setBoard={setBoard}
                refetch={refetch}
              />
            ) : (
              <ListView rpc={rpc} byColumn={byColumn} activeThreads={activeThreads} selectedId={openTaskId} onOpen={setOpenTaskId} />
            )}
          </div>
          <TaskPanel
            fill={fill}
            task={openTask}
            projectId={projectId}
            rpc={rpc}
            threadActive={openTask?.threadId ? activeThreads.has(openTask.threadId) : false}
            onClose={() => setOpenTaskId(null)}
          />
        </div>
      )}

      <NewTaskDialog open={creating} projectId={projectId} rpc={rpc} onClose={() => setCreating(false)} />
      <LessonsDialog
        open={lessonsOpen}
        projectId={projectId}
        lessons={board?.lessons ?? []}
        rpc={rpc}
        onClose={() => setLessonsOpen(false)}
      />
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
