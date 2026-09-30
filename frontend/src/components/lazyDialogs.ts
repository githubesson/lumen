import { lazy } from "react";
import { lazyChunk } from "../lib/lazyChunk";

// Dialogs outside the startup bundle. Open them through `openWhenLoaded`
// so a dismissal while the chunk is still loading is honored.
export const settingsDialogChunk = lazyChunk(() => import("./SettingsDialog"));
export const SettingsDialog = lazy(settingsDialogChunk.load);

export const uploadDialogChunk = lazyChunk(() => import("./UploadDialog"));
export const UploadDialog = lazy(uploadDialogChunk.load);

export const commandPaletteChunk = lazyChunk(() => import("./CommandPalette"));
export const CommandPalette = lazy(commandPaletteChunk.load);
