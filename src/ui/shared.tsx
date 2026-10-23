import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../../server";
import type { Lesson, Task } from "../model";

export type ShipyardRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export function useShipyardRpc(): ShipyardRpc {
  return useRpc<typeof rpcContract>();
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Run an RPC and toast its error; resolves to undefined on failure. */
export async function attempt<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (cause) {
    toast.error(errorText(cause));
    return undefined;
  }
}

export interface Board {
  tasks: Task[];
  lessons: Lesson[];
  maxParallel: number;
}

/** The board of one project, refetched on every server change signal. */
export function useBoard(projectId: string | null) {
  const rpc = useShipyardRpc();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(projectId);
  latest.current = projectId;

  const refetch = useCallback(() => {
    if (!projectId) return;
    rpc.call("board_get", { projectId }).then(
      (result) => {
        if (latest.current !== projectId) return;
        setBoard(result);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc, projectId]);

  useEffect(() => {
    setBoard(null);
    refetch();
  }, [refetch]);

  useRealtime("board-changed", (payload) => {
    const changed = (payload as { projectId?: string | null } | null)?.projectId;
    if (changed === undefined || changed === null || changed === projectId) refetch();
  });

  return { board, setBoard, error, refetch, rpc };
}

export function NativeSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <div className={cn("relative inline-flex", className)}>
      <select
        className="h-8 w-full cursor-pointer appearance-none rounded-md border border-input bg-transparent py-1 pl-2.5 pr-8 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        {...props}
      >
        {children}
      </select>
      <Icon
        name="ChevronDown"
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent",
        className,
      )}
    />
  );
}

export function Chip({ children, tone = "muted", title }: {
  children: ReactNode;
  tone?: "muted" | "good" | "bad" | "warn";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium leading-none",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "good" && "bg-primary/10 text-primary",
        tone === "bad" && "bg-destructive/10 text-destructive",
        tone === "warn" && "bg-muted text-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
