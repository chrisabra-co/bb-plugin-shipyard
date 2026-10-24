// Skill pickers: the project's skills come from the agent provider, and any
// other name can be typed in.
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { STAGES, STAGE_LABELS, type Stage } from "../constants";
import type { Skill, StageSkills } from "../model";
import { NativeSelect, type ShipyardRpc } from "./shared";

const SKILL_NAME = /^[\w.:@/-]+$/;
const cache = new Map<string, Promise<Skill[]>>();

export function useSkills(rpc: ShipyardRpc, projectId: string): Skill[] {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    let cancelled = false;
    let request = cache.get(projectId);
    if (!request) {
      request = rpc.call("skills_list", { projectId }).then(
        (result) => result.skills,
        () => {
          cache.delete(projectId);
          return [];
        },
      );
      cache.set(projectId, request);
    }
    void request.then((list) => {
      if (!cancelled) setSkills(list);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc, projectId]);
  return skills;
}

export function SkillChips({
  skills,
  onRemove,
  muted = false,
}: {
  skills: readonly string[];
  onRemove?: (skill: string) => void;
  muted?: boolean;
}) {
  if (skills.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {skills.map((skill) => (
        <li
          key={skill}
          className={
            muted
              ? "inline-flex h-6 items-center rounded-md border border-dashed border-border px-2 font-mono text-xs text-muted-foreground"
              : "inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background pl-2 pr-0.5 font-mono text-xs text-foreground"
          }
        >
          {skill}
          {onRemove && !muted ? (
            <button
              type="button"
              aria-label={`Remove ${skill}`}
              onClick={() => onRemove(skill)}
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon name="X" aria-hidden className="size-3" />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A text field with the project's skills as suggestions. */
export function SkillAdder({
  suggestions,
  exclude,
  onAdd,
  label = "Add a skill",
}: {
  suggestions: readonly Skill[];
  exclude: readonly string[];
  onAdd: (skill: string) => void;
  label?: string;
}) {
  const listId = useId();
  const [value, setValue] = useState("");
  const name = value.trim();
  const valid = name !== "" && SKILL_NAME.test(name) && !exclude.includes(name);
  const add = () => {
    if (!valid) return;
    onAdd(name);
    setValue("");
  };
  return (
    <div className="flex gap-2">
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        }}
        list={listId}
        placeholder="Add a skill"
        aria-label={label}
        className="h-8 text-xs placeholder:font-sans [&:not(:placeholder-shown)]:font-mono"
      />
      <datalist id={listId}>
        {suggestions
          .filter((skill) => !exclude.includes(skill.name))
          .map((skill) => (
            <option key={skill.name} value={skill.name}>
              {skill.description.slice(0, 80)}
            </option>
          ))}
      </datalist>
      <Button type="button" size="sm" variant="outline" onClick={add} disabled={!valid}>
        Add
      </Button>
    </div>
  );
}

/** A task's own skills, by stage. They add to the project's skills. */
export function TaskSkillsEditor({
  value,
  onChange,
  suggestions,
}: {
  value: StageSkills;
  onChange: (next: StageSkills) => void;
  suggestions: readonly Skill[];
}) {
  const [stage, setStage] = useState<Stage>("implement");
  const used = STAGES.filter((item) => (value[item]?.length ?? 0) > 0);
  const set = (target: Stage, skills: string[]) => {
    const next: StageSkills = { ...value };
    if (skills.length === 0) delete next[target];
    else next[target] = skills;
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {used.length > 0 ? (
        <dl className="space-y-1.5">
          {used.map((item) => (
            <div key={item} className="flex items-start gap-3">
              <dt className="w-24 shrink-0 pt-0.5 text-xs text-muted-foreground">{STAGE_LABELS[item]}</dt>
              <dd className="min-w-0 flex-1">
                <SkillChips
                  skills={value[item] ?? []}
                  onRemove={(skill) => set(item, (value[item] ?? []).filter((other) => other !== skill))}
                />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="flex gap-2">
        <NativeSelect
          aria-label="Stage"
          value={stage}
          onChange={(event) => setStage(event.target.value as Stage)}
          className="w-32 shrink-0"
        >
          {STAGES.map((item) => (
            <option key={item} value={item}>
              {STAGE_LABELS[item]}
            </option>
          ))}
        </NativeSelect>
        <div className="min-w-0 flex-1">
          <SkillAdder
            suggestions={suggestions}
            exclude={value[stage] ?? []}
            onAdd={(skill) => set(stage, [...(value[stage] ?? []), skill])}
            label={`Add a skill to the ${STAGE_LABELS[stage]} stage`}
          />
        </div>
      </div>
    </div>
  );
}
