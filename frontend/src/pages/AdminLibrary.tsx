import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, type MusicRoot } from "../api";
import { ArtistGridPinsSection } from "./admin/ArtistGridPinsSection";
import { FilenPinsSection } from "./admin/FilenPinsSection";
import { MusicRootsSection } from "./admin/MusicRootsSection";

/**
 * Section for the unified Admin page. Manages music roots + ArtistGrid trackers
 * + Filen shares. Does not render an outer `.view` wrapper or page title — the
 * parent page provides those. The three sub-sections share a single error
 * banner and the configured-roots list (used to populate the pin source
 * pickers).
 */
export function LibraryAdminSection() {
  const [roots, setRoots] = useState<MusicRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onError = useCallback((message: string) => {
    setError(message || null);
  }, []);

  const loadRoots = useCallback(async () => {
    try {
      setRoots(await api.listMusicRoots());
    } catch (err) {
      setError(errorMessage(err, "Failed to load roots."));
    }
  }, []);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  const rootOptions = useMemo(
    () =>
      (roots ?? []).map((r) => ({
        value: r.path,
        label: r.primary
          ? `Primary - ${r.path}`
          : `${r.label || "Source"} - ${r.path}`,
        disabled: !r.exists,
      })),
    [roots],
  );

  const defaultRootPath = roots?.[0]?.path ?? "";

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <MusicRootsSection
        roots={roots}
        reloadRoots={loadRoots}
        error={error}
        onError={onError}
      />
      <ArtistGridPinsSection
        rootOptions={rootOptions}
        defaultRootPath={defaultRootPath}
        onError={onError}
      />
      <FilenPinsSection
        rootOptions={rootOptions}
        defaultRootPath={defaultRootPath}
        onError={onError}
      />
    </div>
  );
}
