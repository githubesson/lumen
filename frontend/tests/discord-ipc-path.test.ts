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

it("skips a stale socket left behind and connects to the next that answers", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { createServer } = await import("node:net");
  const { join } = await import("node:path");
  const { connectFirstSocket } = await import("../electron/discord-ipc-path");
  const dir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "discord-ipc-"));
  const stale = join(dir, "discord-ipc-0");
  writeFileSync(stale, ""); // a leftover file: refuses connections
  mkdirSync(join(dir, "app"));
  const live = join(dir, "app", "discord-ipc-0");
  let accepted = 0;
  const server = createServer((s) => {
    accepted++;
    s.end();
  });
  await new Promise<void>((resolve) => server.listen(live, resolve));
  try {
    const socket = await connectFirstSocket([stale, live]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accepted).toBe(1);
    socket.destroy();
    await expect(connectFirstSocket([stale])).rejects.toBeTruthy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
