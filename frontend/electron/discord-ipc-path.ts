import { existsSync } from "node:fs";
import { join } from "node:path";

// Sandboxed Linux Discord builds put their socket in a per-app folder under
// the runtime dir; discord-rpc only looks in the runtime dir itself.
const LINUX_SUBDIRS = [
  "",
  "app/com.discordapp.Discord",
  "app/com.discordapp.DiscordCanary",
  "app/com.discordapp.DiscordPTB",
  "app/dev.vencord.Vesktop",
  "app/xyz.armcord.ArmCord",
  "snap.discord",
  "snap.discord-canary",
];

/** Every socket path Discord may listen on, most likely first. */
export function discordIpcPaths(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    return Array.from({ length: 10 }, (_, id) => `\\\\?\\pipe\\discord-ipc-${id}`);
  }
  const base = (env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || "/tmp").replace(/\/$/, "");
  const dirs = platform === "linux" ? LINUX_SUBDIRS.map((sub) => (sub ? join(base, sub) : base)) : [base];
  return dirs.flatMap((dir) => Array.from({ length: 10 }, (_, id) => `${dir}/discord-ipc-${id}`));
}

/** The first socket that exists, or undefined to let discord-rpc search as before. */
export function findDiscordIpcPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  return discordIpcPaths().find((path) => existsSync(path));
}

/**
 * The discord-rpc transport to use: on Linux, its IPC transport connecting to
 * the socket found above (Flatpak/Snap/Vesktop included), else plain "ipc".
 */
export function discordTransport(): string {
  if (process.platform !== "linux") return "ipc";
  /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
  const transports = require("discord-rpc/src/transports");
  if (!transports["lumen-ipc"]) {
    const IPC = transports.ipc;
    const net = require("node:net");
    transports["lumen-ipc"] = class extends IPC {
      async connect(this: any): Promise<void> {
        const path = findDiscordIpcPath();
        if (!path) return super.connect();
        // Same as discord-rpc's IPCTransport.connect, on the socket found above.
        const socket = (this.socket = await new Promise<any>((resolve, reject) => {
          const s = net.createConnection(path, () => {
            s.removeListener("error", reject);
            resolve(s);
          });
          s.once("error", reject);
        }));
        socket.on("close", this.onClose.bind(this));
        socket.on("error", this.onClose.bind(this));
        this.emit("open");
        socket.write(IPC.encode(0, { v: 1, client_id: this.client.clientId }));
        socket.pause();
        socket.on("readable", () => {
          IPC.decode(socket, ({ op, data }: { op: number; data: any }) => {
            if (op === 3) this.send(data, 4); // PING → PONG
            else if (op === 1 && data) this.emit("message", data);
            else if (op === 2) this.emit("close", data);
          });
        });
      }
    };
  }
  /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
  return "lumen-ipc";
}
