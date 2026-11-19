// The settings as a page under Paseo's Settings → Plugins → Vibe Board. They stay in the
// board server's config.json, so the iTerm2 panel, which has its own dialog, shows the same.

import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { unwrap } from "../shared/http";
import { boardRpc } from "../shared/rpc";
import type { BoardData, Settings } from "./board/host";
import { archiveChoices, textSizeChoices } from "./board/Settings";

export function SettingsScreen(_: PluginSurfaceProps) {
  const call = useRpc(boardRpc);
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const board = unwrap(await call({ method: "GET", path: "/api/board" }), "GET /api/board") as BoardData;
      if (!board.settings) throw new Error("The board server is older than this plugin: run ./install.sh in the vibe-board clone");
      return board.settings;
    },
    throwOnError: true,
  });
  const save = useMutation({
    mutationFn: async (change: Partial<Settings>) => unwrap(await call({ method: "PATCH", path: "/api/settings", body: change }), "PATCH /api/settings"),
    onSettled: () => settings.refetch(),
  });
  if (!settings.data) return null;
  const { text_size, archive_after_days } = settings.data;
  return (
    <SettingsSection title="Board">
      <SettingsCard>
        {/* A server from before the setting does not report it. */}
        {text_size !== undefined && (
          <SettingsSelect
            label="Text size"
            value={String(text_size)}
            options={textSizeChoices(text_size)}
            disabled={save.isPending}
            onValueChange={(value) => save.mutate({ text_size: Number(value) })}
          />
        )}
        <SettingsSelect
          label="Archive finished tasks after"
          value={archive_after_days === null ? "" : String(archive_after_days)}
          options={archiveChoices(archive_after_days)}
          disabled={save.isPending}
          error={save.error?.message}
          onValueChange={(value) => save.mutate({ archive_after_days: value ? Number(value) : null })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
