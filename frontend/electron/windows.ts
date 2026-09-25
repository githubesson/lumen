import { BrowserWindow, screen, shell } from "electron";
import * as path from "node:path";
import type { Rectangle } from "electron";
import type { LocalProxy } from "./local-proxy";
import type { DesktopUpdateManager } from "./updater";

const MAIN_PRELOAD = path.join(__dirname, "mainPreload.js");
const NORMAL_MIN_SIZE = { width: 640, height: 480 };
const MINI_PLAYER_SIZE = { width: 780, height: 184 };

export interface WindowManager {
  readonly mainWindow: BrowserWindow | null;
  readonly isMiniPlayer: boolean;
  alwaysOnTop: boolean;
  openMain(): Promise<void>;
  setMiniPlayerMode(enabled: boolean): void;
}

export function createWindowManager(options: {
  localProxy: LocalProxy;
  updateManager: DesktopUpdateManager;
}): WindowManager {
  const { localProxy, updateManager } = options;
  let mainWindow: BrowserWindow | null = null;
  let isMiniPlayer = false;
  let normalBounds: Rectangle | null = null;
  let alwaysOnTop = false;

  // The renderer only ever needs the local proxy origin. Without these guards a compromised or injected
  // renderer could navigate the main window to any remote origin, and
  // `window.open` would create unrestricted child BrowserWindows. contextIsolation
  // + sandbox + nodeIntegration:false make that not-immediately-RCE, but this is
  // the standard Electron hardening baseline and the missing link that turns a
  // renderer compromise into a real chain.
  function isInternalURL(rawUrl: string): boolean {
    try {
      const u = new URL(rawUrl);
      return (
        u.protocol === "http:" &&
        (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
        u.port === String(localProxy.port)
      );
    } catch {
      return false;
    }
  }

  function hardenNavigation(win: BrowserWindow): void {
    const block = (event: { preventDefault: () => void }, url: string) => {
      if (isInternalURL(url)) return;
      event.preventDefault();
      console.warn("[electron] blocked navigation to", url);
    };
    win.webContents.on("will-navigate", (event, url) => block(event, url));
    win.webContents.on("will-redirect", (event, url) => block(event, url));
    // Never open a child BrowserWindow. External links go through the
    // `external:open` IPC, which validates the protocol and hands off to the
    // system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  }

  async function openMain(): Promise<void> {
    if (mainWindow) {
      mainWindow.focus();
      return;
    }
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: NORMAL_MIN_SIZE.width,
      minHeight: NORMAL_MIN_SIZE.height,
      backgroundColor: "#00000000",
      frame: false,
      transparent: true,
      title: "Lumen — Music Library",
      autoHideMenuBar: true,
      alwaysOnTop,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: MAIN_PRELOAD,
      },
    });
    hardenNavigation(mainWindow);
    mainWindow.on("closed", () => {
      mainWindow = null;
      isMiniPlayer = false;
      normalBounds = null;
    });
    await mainWindow.loadURL(`http://127.0.0.1:${localProxy.port}/`);
    updateManager.startAutomaticChecks();
  }

  function setMiniPlayerMode(enabled: boolean): void {
    if (!mainWindow || enabled === isMiniPlayer) return;

    if (enabled) {
      if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
        normalBounds = mainWindow.getBounds();
      }
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
      mainWindow.setMinimumSize(MINI_PLAYER_SIZE.width, MINI_PLAYER_SIZE.height);
      mainWindow.setMaximumSize(MINI_PLAYER_SIZE.width, MINI_PLAYER_SIZE.height);
      mainWindow.setResizable(false);
      mainWindow.setMaximizable(false);
      mainWindow.setBounds(
        boundsAroundCenter(mainWindow.getBounds(), MINI_PLAYER_SIZE),
        true,
      );
    } else {
      mainWindow.setResizable(true);
      mainWindow.setMaximizable(true);
      mainWindow.setMaximumSize(10000, 10000);
      mainWindow.setMinimumSize(NORMAL_MIN_SIZE.width, NORMAL_MIN_SIZE.height);
      if (normalBounds) {
        mainWindow.setBounds(normalBounds, true);
        normalBounds = null;
      } else {
        mainWindow.setSize(1280, 820, true);
      }
    }

    isMiniPlayer = enabled;
  }

  return {
    get mainWindow() {
      return mainWindow;
    },
    get isMiniPlayer() {
      return isMiniPlayer;
    },
    get alwaysOnTop() {
      return alwaysOnTop;
    },
    set alwaysOnTop(value: boolean) {
      alwaysOnTop = value;
    },
    openMain,
    setMiniPlayerMode,
  };
}

function boundsAroundCenter(
  bounds: Rectangle,
  size: { width: number; height: number },
): Rectangle {
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const x = Math.round(
    Math.max(area.x, Math.min(area.x + area.width - size.width, centerX - size.width / 2)),
  );
  const y = Math.round(
    Math.max(area.y, Math.min(area.y + area.height - size.height, centerY - size.height / 2)),
  );
  return { x, y, width: size.width, height: size.height };
}
