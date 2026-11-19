// The settings as a page under Paseo's Settings → Plugins → Vibe Board. The board server
// keeps them in config.json, so every panel shows what was set here.

import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { unwrap } from "../shared/http";
import { boardRpc } from "../shared/rpc";
import type { BoardData, Settings } from "./board/host";

const TEXT_SIZES = [85, 100, 115, 130, 150, 175]; // percent
const ARCHIVE_AFTER = [1, 3, 7, 14, 30, 90]; // days

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

function textSizeChoices(current: number) {
  return withCurrent(TEXT_SIZES, current).map((n) => ({ value: String(n), label: `${n}%` }));
}

/** "" is never. */
function archiveChoices(current: number | null) {
  return [...withCurrent(ARCHIVE_AFTER, current).map((n) => ({ value: String(n), label: n === 1 ? "1 day" : `${n} days` })), { value: "", label: "never" }];
}

/** The offered values, plus what config.json holds when that is none of them. */
function withCurrent(offered: number[], current: number | null): number[] {
  return current === null || offered.includes(current) ? offered : [...offered, current].sort((x, y) => x - y);
}
