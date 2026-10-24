import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { COLUMNS, COLUMN_LABELS, type ColumnId, STAGE_LABELS, shortModelName, trackStep } from "../constants";
import type { Task } from "../model";
import { EMPTY_HINTS } from "./BoardView";
import { QuickActions } from "./actions";
import { type ShipyardRpc, relativeTime } from "./shared";
import { StatusLine } from "./TaskCard";

function stageText(task: Task): string {
  const step = trackStep(task);
  return step ? STAGE_LABELS[step] : "";
}

/** The board as grouped rows, like a task list. */
export function ListView({
  byColumn,
  activeThreads,
  selectedId,
  onOpen,
  rpc,
}: {
  rpc: ShipyardRpc;
  byColumn: Map<ColumnId, Task[]>;
  activeThreads: Set<string>;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<ColumnId>>(() => new Set(["done"]));
  const toggle = (column: ColumnId) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 md:px-6">
      <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-sm">
        <colgroup>
          <col />
          <col className="w-56" />
          <col className="w-28" />
          <col className="w-28" />
          <col className="w-24" />
          <col className="w-36" />
        </colgroup>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="h-9 border-b border-border px-2 font-normal">
              Task
            </th>
            <th scope="col" className="h-9 border-b border-border px-2 font-normal">
              Status
            </th>
            <th scope="col" className="h-9 border-b border-border px-2 font-normal">
              Stage
            </th>
            <th scope="col" className="h-9 border-b border-border px-2 font-normal">
              Model
            </th>
            <th scope="col" className="h-9 border-b border-border px-2 text-right font-normal">
              Updated
            </th>
            <th scope="col" className="h-9 border-b border-border px-2 font-normal">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {COLUMNS.map((column) => {
          const tasks = byColumn.get(column) ?? [];
          const open = !collapsed.has(column);
          return (
            <tbody key={column}>
              <tr>
                <th colSpan={6} scope="colgroup" className="px-0 pb-1 pt-5 text-left font-normal">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggle(column)}
                    className="inline-flex items-center gap-1.5 rounded px-1 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon
                      name="ChevronRight"
                      aria-hidden
                      className={cn("size-4 text-muted-foreground motion-safe:transition-transform", open && "rotate-90")}
                    />
                    {COLUMN_LABELS[column]}
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">{tasks.length}</span>
                  </button>
                </th>
              </tr>
              {open && tasks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="border-b border-border/60 px-2 py-2 text-xs text-muted-foreground">
                    {EMPTY_HINTS[column]}
                  </td>
                </tr>
              ) : null}
              {open
                ? tasks.map((task) => (
                    <tr
                      key={task.id}
                      onClick={() => onOpen(task.id)}
                      className={cn(
                        "group cursor-pointer hover:bg-state-hover",
                        selectedId === task.id && "bg-state-active hover:bg-state-active",
                      )}
                    >
                      <td className="h-10 truncate border-b border-border/60 px-2">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpen(task.id);
                          }}
                          className="max-w-full truncate rounded text-left font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {task.title}
                        </button>
                      </td>
                      <td className="h-10 border-b border-border/60 px-2">
                        <StatusLine task={task} threadActive={task.threadId !== null && activeThreads.has(task.threadId)} />
                      </td>
                      <td className="h-10 truncate border-b border-border/60 px-2 text-xs text-muted-foreground">
                        {stageText(task)}
                      </td>
                      <td className="h-10 truncate border-b border-border/60 px-2 text-xs text-muted-foreground">
                        {shortModelName(task.triage?.model ?? null) ?? ""}
                      </td>
                      <td
                        className="h-10 border-b border-border/60 px-2 text-right text-xs tabular-nums text-muted-foreground"
                        title={new Date(task.updatedAt).toLocaleString()}
                      >
                        {relativeTime(task.updatedAt)}
                      </td>
                      <td className="h-10 border-b border-border/60 px-2">
                        <QuickActions
                          task={task}
                          rpc={rpc}
                          className={cn(
                            "justify-end opacity-0 transition-opacity motion-reduce:transition-none",
                            "group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
                            selectedId === task.id && "opacity-100",
                          )}
                        />
                      </td>
                    </tr>
                  ))
                : null}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
