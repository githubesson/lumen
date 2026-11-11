// @vitest-environment node
import { expect, it } from "vitest";
import { discordIpcPaths } from "../electron/discord-ipc-path";

it("looks in the runtime dir first, then Flatpak, Vesktop and Snap folders on Linux", () => {
  const paths = discordIpcPaths("linux", { XDG_RUNTIME_DIR: "/run/user/1000/" });
  expect(paths[0]).toBe("/run/user/1000/discord-ipc-0");
  expect(paths).toContain("/run/user/1000/app/com.discordapp.Discord/discord-ipc-0");
  expect(paths).toContain("/run/user/1000/app/dev.vencord.Vesktop/discord-ipc-0");
  expect(paths).toContain("/run/user/1000/snap.discord/discord-ipc-0");
});

it("keeps discord-rpc's own paths elsewhere", () => {
  expect(discordIpcPaths("darwin", { TMPDIR: "/var/tmp/" })[0]).toBe("/var/tmp/discord-ipc-0");
  expect(discordIpcPaths("win32", {})[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
});
