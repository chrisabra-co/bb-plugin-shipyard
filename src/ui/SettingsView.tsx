// Settings inside the board. "This project" overrides any default for one
// project; "All projects" edits the defaults, which are also the plugin's bb
// settings.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  experimental_BranchPicker as BranchPicker,
  experimental_useProviders as useProviders,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { STAGES, STAGE_HINTS, STAGE_LABELS, type Stage } from "../constants";
import type { SettingsPatch, ShipyardSettings, StageSkills } from "../model";
import { NativeSelect, Segmented, type ShipyardRpc, attempt, errorText } from "./shared";
import { SkillAdder, SkillChips, useSkills } from "./skills";

type Scope = "project" | "defaults";
type Key = keyof ShipyardSettings;

interface SettingsViewData {
  defaults: ShipyardSettings;
  overrides: Partial<ShipyardSettings>;
  effective: ShipyardSettings;
  stageSkills: { defaults: StageSkills; project: StageSkills };
}

const PERMISSION_TEXT: Record<ShipyardSettings["permissionMode"], { label: string; detail: string }> = {
  full: {
    label: "Full access",
    detail: "Agents run any command without asking. The worktree keeps changes off your branch, but commands still run on your machine.",
  },
  auto: {
    label: "Auto",
    detail: "A classifier reviews each action and blocks risky ones. Some tasks can stop to wait for you.",
  },
  "accept-edits": {
    label: "Accept edits",
    detail: "Agents edit files freely but ask before other commands. Unattended tasks often stop to wait for you.",
  },
};

const PLANNING_LABELS: Record<ShipyardSettings["planning"], string> = {
  auto: "When triage asks",
  always: "Always",
  never: "Never",
};

function describe(key: Key, value: ShipyardSettings[Key], providerName: (id: string) => string): string {
  switch (key) {
    case "providerId":
      return value ? providerName(value as string) : "Project default";
    case "baseBranch":
      return (value as string) || "Project default";
    case "planning":
      return PLANNING_LABELS[value as ShipyardSettings["planning"]];
    case "permissionMode":
      return PERMISSION_TEXT[value as ShipyardSettings["permissionMode"]].label;
    case "mergeMethod":
      return `${String(value).charAt(0).toUpperCase()}${String(value).slice(1)}`;
    default:
      return typeof value === "boolean" ? (value ? "On" : "Off") : String(value);
  }
}

function applyPatch(view: SettingsViewData, scope: Scope, patch: SettingsPatch): SettingsViewData {
  const defaults = { ...view.defaults };
  const overrides: Partial<ShipyardSettings> = { ...view.overrides };
  for (const [key, value] of Object.entries(patch) as [Key, ShipyardSettings[Key] | null | undefined][]) {
    if (value === undefined) continue;
    if (scope === "defaults") {
      if (value !== null) Object.assign(defaults, { [key]: value });
    } else if (value === null) delete overrides[key];
    else Object.assign(overrides, { [key]: value });
  }
  return { ...view, defaults, overrides, effective: { ...defaults, ...overrides } };
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "transition-colors motion-reduce:transition-none",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-4 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function Row({
  label,
  description,
  control,
  below,
  note,
}: {
  label: string;
  description: ReactNode;
  control: ReactNode;
  below?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="min-w-0 max-w-md space-y-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
        {below}
        {note}
      </div>
      <div className="shrink-0 sm:pt-0.5">{control}</div>
    </div>
  );
}

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="pb-2">
        <h2 className="text-base font-medium text-foreground">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="divide-y divide-border border-y border-border">{children}</div>
    </section>
  );
}

export function SettingsView({
  projectId,
  projectName,
  rpc,
  onBack,
}: {
  projectId: string;
  projectName: string;
  rpc: ShipyardRpc;
  onBack: () => void;
}) {
  const sdk = useSdk();
  const providers = useProviders();
  const skills = useSkills(rpc, projectId);
  const [scope, setScope] = useState<Scope>("project");
  const [view, setView] = useState<SettingsViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    rpc.call("settings_get", { projectId }).then(
      (result) => {
        if (!cancelled) setView(result);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      },
    );
    sdk.projects.get({ projectId }).then(
      (project) => {
        if (cancelled) return;
        const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
        setHostId(source?.hostId ?? null);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, sdk, projectId]);

  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
  if (!view) return null;

  const providerName = (id: string) => providers.providers.find((provider) => provider.id === id)?.displayName ?? id;
  const values = scope === "defaults" ? view.defaults : view.effective;

  const save = async (patch: SettingsPatch) => {
    // Show the change at once, so a second quick click builds on the first.
    setView((current) => (current ? applyPatch(current, scope, patch) : current));
    const result = await attempt(rpc.call("settings_set", { projectId, scope, patch }));
    if (result) setView(result);
    else
      void rpc.call("settings_get", { projectId }).then(setView, () => undefined);
  };
  const set = <K extends Key>(key: K, value: ShipyardSettings[K]) => void save({ [key]: value } as SettingsPatch);

  /** In project scope, say what the default is and offer to go back to it. */
  const note = (key: Key): ReactNode => {
    if (scope !== "project") return null;
    const overridden = key in view.overrides;
    return (
      <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {overridden ? (
          <>
            <span>Default: {describe(key, view.defaults[key], providerName)}</span>
            <button
              type="button"
              onClick={() => void save({ [key]: null } as SettingsPatch)}
              className="rounded text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Use default
            </button>
          </>
        ) : (
          <span>Uses the default</span>
        )}
      </span>
    );
  };

  const stageList = (stage: Stage) => {
    const defaults = view.stageSkills.defaults[stage] ?? [];
    const own = view.stageSkills.project[stage];
    const setSkills = async (list: string[] | null) => {
      const result = await attempt(rpc.call("stage_skills_set", { projectId, scope, stage, skills: list }));
      if (result) setView(result);
    };
    if (scope === "defaults") {
      return {
        chips: <SkillChips skills={defaults} onRemove={(skill) => void setSkills(defaults.filter((item) => item !== skill))} />,
        adder: <SkillAdder suggestions={skills} exclude={defaults} onAdd={(skill) => void setSkills([...defaults, skill])} />,
        note: null,
      };
    }
    if (own === undefined) {
      return {
        chips: <SkillChips skills={defaults} muted />,
        adder: <SkillAdder suggestions={skills} exclude={defaults} onAdd={(skill) => void setSkills([...defaults, skill])} />,
        note: (
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{defaults.length > 0 ? "Uses the default skills" : "No skills by default"}</span>
            {defaults.length > 0 ? (
              <button
                type="button"
                onClick={() => void setSkills([...defaults])}
                className="rounded text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                Customize
              </button>
            ) : null}
          </span>
        ),
      };
    }
    return {
      chips: <SkillChips skills={own} onRemove={(skill) => void setSkills(own.filter((item) => item !== skill))} />,
      adder: <SkillAdder suggestions={skills} exclude={own} onAdd={(skill) => void setSkills([...own, skill])} />,
      note: (
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{defaults.length > 0 ? `Default: ${defaults.join(", ")}` : "No skills by default"}</span>
          <button
            type="button"
            onClick={() => void setSkills(null)}
            className="rounded text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Use default
          </button>
        </span>
      ),
    };
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-10 px-5 pb-16 pt-6 md:px-8">
        <div className="space-y-4">
          <Button size="sm" variant="ghost" className="-ml-2 text-muted-foreground" onClick={onBack}>
            <Icon name="ArrowLeft" className="size-4" />
            Back to the board
          </Button>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl font-medium text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                {scope === "project"
                  ? `Changes here apply only to ${projectName}. Other settings follow the defaults.`
                  : "Defaults for every project. A project can override each one."}
              </p>
            </div>
            <Segmented<Scope>
              label="Settings scope"
              value={scope}
              options={[
                { value: "project", label: projectName.length > 24 ? "This project" : projectName },
                { value: "defaults", label: "All projects" },
              ]}
              onChange={setScope}
            />
          </div>
        </div>

        <Group title="Queue">
          <Row
            note={note("maxParallel")}
            label="Parallel tasks"
            description="How many tasks of a project run at the same time. The rest wait in the queue."
            control={
              <div className="inline-flex items-center rounded-md border border-input">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 rounded-r-none"
                  aria-label="Fewer parallel tasks"
                  disabled={values.maxParallel <= 1}
                  onClick={() => set("maxParallel", values.maxParallel - 1)}
                >
                  <Icon name="Minus" className="size-4" />
                </Button>
                <span className="w-10 text-center text-sm tabular-nums" aria-live="polite">
                  {values.maxParallel}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 rounded-l-none"
                  aria-label="More parallel tasks"
                  disabled={values.maxParallel >= 24}
                  onClick={() => set("maxParallel", values.maxParallel + 1)}
                >
                  <Icon name="Plus" className="size-4" />
                </Button>
              </div>
            }
          />
        </Group>

        <Group title="Pipeline" description="The stages each task runs before it reaches you.">
          <Row
            note={note("triage")}
            label="Triage"
            description="A short first turn picks the model, the effort, and whether to plan. Off: the provider's default model runs every task."
            control={<Switch label="Triage" checked={values.triage} onChange={(next) => set("triage", next)} />}
          />
          <Row
            note={note("allowHardest")}
            label="Most capable model"
            description="Let triage pick the top tier (Fable on Claude) for the hardest tasks. It costs more."
            control={<Switch label="Most capable model" checked={values.allowHardest} onChange={(next) => set("allowHardest", next)} />}
          />
          <Row
            note={note("planning")}
            label="Plan first"
            description="When the agent writes a plan before it changes code. A task can override this."
            control={
              <Segmented<ShipyardSettings["planning"]>
                label="Plan first"
                value={values.planning}
                options={(["auto", "always", "never"] as const).map((value) => ({ value, label: PLANNING_LABELS[value] }))}
                onChange={(next) => set("planning", next)}
              />
            }
          />
          <Row
            note={note("planApproval")}
            label="Approve plans"
            description="Stop after the plan so you can approve or change it before any code."
            control={<Switch label="Approve plans" checked={values.planApproval} onChange={(next) => set("planApproval", next)} />}
          />
          <Row
            note={note("validation")}
            label="Validate"
            description="Run the checks and review the diff with fresh eyes before the task reaches you."
            control={<Switch label="Validate" checked={values.validation} onChange={(next) => set("validation", next)} />}
          />
        </Group>

        <Group title="Agents">
          <Row
            note={note("providerId")}
            label="Provider"
            description="The agent that runs the tasks."
            control={
              <NativeSelect
                aria-label="Provider"
                value={values.providerId}
                onChange={(event) => set("providerId", event.target.value)}
                className="w-52"
              >
                <option value="">Project default</option>
                {providers.providers
                  .filter((provider) => provider.available || provider.id === values.providerId)
                  .map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  ))}
              </NativeSelect>
            }
          />
          <Row
            note={note("permissionMode")}
            label="Permissions"
            description={PERMISSION_TEXT[values.permissionMode].detail}
            control={
              <NativeSelect
                aria-label="Permissions"
                value={values.permissionMode}
                onChange={(event) => set("permissionMode", event.target.value as ShipyardSettings["permissionMode"])}
                className="w-52"
              >
                {(Object.keys(PERMISSION_TEXT) as ShipyardSettings["permissionMode"][]).map((mode) => (
                  <option key={mode} value={mode}>
                    {PERMISSION_TEXT[mode].label}
                  </option>
                ))}
              </NativeSelect>
            }
          />
        </Group>

        <Group title="Git">
          <Row
            note={note("baseBranch")}
            label="Base branch"
            description="Worktrees start from this branch and pull requests target it."
            below={
              values.baseBranch ? (
                <button
                  type="button"
                  onClick={() => set("baseBranch", "")}
                  className="rounded text-xs text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Use the project's default branch
                </button>
              ) : null
            }
            control={
              <BranchPicker
                hostId={hostId}
                projectId={projectId}
                value={values.baseBranch || null}
                onChange={(next) => set("baseBranch", next ?? "")}
                placeholder="Project default"
              />
            }
          />
          <Row
            note={note("mergeMethod")}
            label="Merge method"
            description="How Merge PR merges a task's pull request."
            control={
              <Segmented<ShipyardSettings["mergeMethod"]>
                label="Merge method"
                value={values.mergeMethod}
                options={(["squash", "merge", "rebase"] as const).map((value) => ({
                  value,
                  label: describe("mergeMethod", value, providerName),
                }))}
                onChange={(next) => set("mergeMethod", next)}
              />
            }
          />
          <Row
            note={note("commitPlans")}
            label="Commit plan documents"
            description="Keep the plan and brainstorm files that skills write in the task's commits. Off: Shipyard keeps the plan on the card."
            control={<Switch label="Commit plan documents" checked={values.commitPlans} onChange={(next) => set("commitPlans", next)} />}
          />
          <Row
            note={note("archiveOnDone")}
            label="Archive finished threads"
            description="Archive a task's thread when the task is done."
            control={<Switch label="Archive finished threads" checked={values.archiveOnDone} onChange={(next) => set("archiveOnDone", next)} />}
          />
        </Group>

        <Group
          title="Skills by stage"
          description={
            scope === "project"
              ? "Agents load these skills each time a task of this project reaches the stage. A project list replaces the default list; a task can add more."
              : "Agents load these skills each time a task reaches the stage, unless a project sets its own list."
          }
        >
          {STAGES.map((stage) => {
            const list = stageList(stage);
            return (
              <div key={stage} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:gap-8">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">{STAGE_LABELS[stage]}</p>
                  <p className="text-sm text-muted-foreground">{STAGE_HINTS[stage]}</p>
                  {list.note}
                </div>
                <div className="space-y-2">
                  {list.chips}
                  {list.adder}
                </div>
              </div>
            );
          })}
        </Group>
      </div>
    </div>
  );
}
