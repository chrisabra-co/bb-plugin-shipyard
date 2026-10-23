// Shipyard frontend: the Kanban board page. React and the SDK come from
// the bb app at load time; `bb plugin build` bundles the rest.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BoardPage } from "./src/ui/Board";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Shipyard",
    icon: "shipyard/kanban",
    path: "board",
    component: BoardPage,
  });
});
