import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { exportTracksAsFiles } from "./download";
import { useKey } from "./keybindings";
import type { TrackListItem } from "../api";

interface UseTrackSelectionOptions<T> {
  items: T[];
  getId: (item: T) => string;
  /** Convert selected items into the queue/track shape needed for export. */
  toExportItems?: (items: T[]) => TrackListItem[];
  /** Disable keyboard shortcuts (e.g. when a modal is open). */
  disabled?: boolean;
}

interface UseTrackSelectionResult<T> {
  selectionMode: boolean;
  setSelectionMode: (value: boolean) => void;
  selectedIds: Set<string>;
  selectedItems: T[];
  allSelected: boolean;
  someSelected: boolean;
  exporting: boolean;
  exportNotice: string | null;
  toggleMode: () => void;
  toggleSelection: (item: T, index: number, range: boolean) => void;
  selectAll: () => void;
  clearSelection: () => void;
  exportSelected: () => Promise<void>;
}

/**
 * Shared selection controller for track tables. Manages selection mode,
 * individual/range selection, select-all, export lifecycle, and the
 * keyboard shortcuts used in TrackList and PlaylistDetail.
 */
export function useTrackSelection<T>({
  items,
  getId,
  toExportItems,
  disabled = false,
}: UseTrackSelectionOptions<T>): UseTrackSelectionResult<T> {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const lastSelectedIndexRef = useRef<number | null>(null);

  const itemsById = useMemo(
    () => new Map(items.map((item, i) => [getId(item), i])),
    [items, getId],
  );

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(getId(item))),
    [items, selectedIds, getId],
  );

  const exportableItems = useMemo(
    () => (toExportItems ? toExportItems(selectedItems) : (selectedItems as unknown as TrackListItem[])),
    [selectedItems, toExportItems],
  );

  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const someSelected = selectedIds.size > 0;

  // Drop selections that no longer exist in the current item list.
  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (itemsById.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [itemsById]);

  useEffect(() => {
    if (selectedIds.size === 0) lastSelectedIndexRef.current = null;
  }, [selectedIds.size]);

  useKey(
    "v",
    (e) => {
      e.preventDefault();
      setSelectionMode((value) => !value);
      setExportNotice(null);
    },
    { id: "selection:toggle-mode", label: "Toggle track selection", group: "Selection", enabled: !disabled },
  );

  useKey(
    "esc",
    (e) => {
      e.preventDefault();
      setSelectionMode(false);
      setSelectedIds(new Set());
      setExportNotice(null);
    },
    {
      id: "selection:clear",
      label: "Clear track selection",
      group: "Selection",
      enabled: selectionMode && !disabled,
      priority: 5,
    },
  );

  useKey(
    "mod+a",
    (e) => {
      e.preventDefault();
      setSelectedIds(new Set(items.map(getId)));
      setSelectionMode(true);
      setExportNotice(null);
    },
    {
      id: "selection:all",
      label: "Select all tracks",
      group: "Selection",
      enabled: selectionMode && !disabled,
    },
  );

  const toggleSelection = useCallback(
    (item: T, index: number, range: boolean) => {
      setSelectionMode(true);
      setExportNotice(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const id = getId(item);
        if (range && lastSelectedIndexRef.current !== null) {
          const from = Math.min(lastSelectedIndexRef.current, index);
          const to = Math.max(lastSelectedIndexRef.current, index);
          for (let pos = from; pos <= to; pos += 1) {
            const rangeItem = items[pos];
            if (rangeItem) next.add(getId(rangeItem));
          }
        } else if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      lastSelectedIndexRef.current = index;
    },
    [items, getId],
  );

  const selectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (items.length > 0 && prev.size === items.length) return new Set();
      return new Set(items.map(getId));
    });
    setSelectionMode(true);
    setExportNotice(null);
  }, [items, getId]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setExportNotice(null);
  }, []);

  const toggleMode = useCallback(() => {
    setSelectionMode((value) => !value);
    setExportNotice(null);
  }, []);

  const exportSelected = useCallback(async () => {
    if (exporting || exportableItems.length === 0) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const result = await exportTracksAsFiles(exportableItems);
      if (result.canceled) {
        setExportNotice("Export canceled.");
        return;
      }
      const parts: string[] = [];
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      if (result.skipped > 0) parts.push(`${result.skipped} streaming-only skipped`);
      const suffix = parts.length > 0 ? `, ${parts.join(", ")}` : "";
      setExportNotice(
        result.usedFolderPicker
          ? `Exported ${result.exported} file${result.exported === 1 ? "" : "s"}${suffix}.`
          : `Export started for ${result.exported} file${result.exported === 1 ? "" : "s"}${suffix}.`,
      );
    } catch (e) {
      setExportNotice((e as Error).message || "Export failed.");
    } finally {
      setExporting(false);
    }
  }, [exporting, exportableItems]);

  return {
    selectionMode,
    setSelectionMode,
    selectedIds,
    selectedItems,
    allSelected,
    someSelected,
    exporting,
    exportNotice,
    toggleMode,
    toggleSelection,
    selectAll,
    clearSelection,
    exportSelected,
  };
}
