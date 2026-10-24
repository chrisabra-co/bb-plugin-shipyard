// Shipyard frontend: the board page, plus a link to its settings from bb's
// plugin settings page. React and the SDK come from the bb app at load time;
// `bb plugin build` bundles the rest.
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { BoardPage } from "./src/ui/Board";

function SettingsLink() {
  const navigate = useBbNavigate();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        The settings above are the defaults for every project. Open Shipyard to override them for one project or to
        pick skills for each stage.
      </p>
      <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("board", { subPath: "settings" })}>
        Open Shipyard settings
      </Button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Shipyard",
    icon: "shipyard/ship",
    path: "board",
    component: BoardPage,
  });
  app.slots.settingsSection({
    id: "project-settings",
    title: "Project settings and skills",
    component: SettingsLink,
  });
});
