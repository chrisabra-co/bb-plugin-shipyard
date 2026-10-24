// Effective settings: the plugin's bb settings are the defaults for every
// project, and each project can override any of them. Stage skills layer the
// same way: a project's list for a stage replaces the default list, and a
// task's own skills add to the result.
import {
  type SettingsOverrides,
  type SettingsPatch,
  type ShipyardSettings,
  type Stage,
  type StageSkills,
  settingsSchema,
} from "./model";
import { DEFAULTS_ROW, type Store, type StoredTask } from "./store";

export class Settings {
  private cached: ShipyardSettings;

  constructor(
    private readonly store: Store,
    private readonly read: () => Promise<ShipyardSettings>,
    private readonly write: (patch: Partial<Record<keyof ShipyardSettings, unknown>>) => Promise<unknown>,
    initial: ShipyardSettings,
  ) {
    this.cached = initial;
  }

  /** Call when bb reports a settings change. */
  async refresh(): Promise<void> {
    this.cached = await this.read();
  }

  defaults(): ShipyardSettings {
    return this.cached;
  }

  overrides(projectId: string): SettingsOverrides {
    return this.store.projectSettings(projectId).overrides;
  }

  /** Synchronous, so bb.agents.configure can use it. */
  effective(projectId: string): ShipyardSettings {
    const merged = { ...this.cached, ...this.overrides(projectId) };
    const parsed = settingsSchema.safeParse(merged);
    return parsed.success ? parsed.data : this.cached;
  }

  async setDefaults(patch: SettingsPatch): Promise<void> {
    const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    if (Object.keys(changes).length === 0) return;
    await this.write(changes);
    await this.refresh();
  }

  setProjectOverrides(projectId: string, patch: SettingsPatch): void {
    const current = this.store.projectSettings(projectId);
    const overrides: Record<string, unknown> = { ...current.overrides };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete overrides[key];
      else overrides[key] = value;
    }
    this.store.saveProjectSettings(projectId, { ...current, overrides: overrides as SettingsOverrides });
  }

  defaultStageSkills(): StageSkills {
    return this.store.projectSettings(DEFAULTS_ROW).stageSkills;
  }

  projectStageSkills(projectId: string): StageSkills {
    return this.store.projectSettings(projectId).stageSkills;
  }

  /**
   * Set one stage's list. `scope` is a project id, or DEFAULTS_ROW for the
   * defaults. For a project, null removes its list so the default applies.
   */
  setStageSkills(scope: string, stage: Stage, skills: string[] | null): void {
    const current = this.store.projectSettings(scope);
    const stageSkills: StageSkills = { ...current.stageSkills };
    if (skills === null) delete stageSkills[stage];
    else stageSkills[stage] = [...new Set(skills)];
    this.store.saveProjectSettings(scope, { ...current, stageSkills });
  }

  /** The skills a task loads at a stage. */
  skillsFor(task: StoredTask, stage: Stage): string[] {
    const project = this.projectStageSkills(task.projectId)[stage];
    const base = project ?? this.defaultStageSkills()[stage] ?? [];
    return [...new Set([...base, ...(task.stageSkills[stage] ?? [])])];
  }
}
