import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { BoardPanel } from "./client/paseo";
import { SettingsScreen } from "./client/settings";

const SETTINGS = "settings";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    // Shown when the plugin is opened under Settings → Plugins; the board's gear opens it too.
    client.addSettingsScreen({ id: SETTINGS, title: "Settings", icon: "Settings", Component: SettingsScreen }),
    // A workspace panel: those are what Explorer's + menu offers.
    client.addWorkspacePanel({
      id: "board",
      title: "Vibe Board",
      icon: "ListTodo",
      locations: ["explorer", "workspace"],
      Component: (props: PluginWorkspacePanelProps) => <BoardPanel {...props} openSettings={() => client.openSettings(SETTINGS)} />,
    }),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
