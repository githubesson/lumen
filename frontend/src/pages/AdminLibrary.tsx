import { useCallback, useMemo, useState } from "react";
import { api, type MusicRoot } from "../api";
import AdminPanel from "../components/admin/AdminPanel";
import { useApiResource } from "../lib/useApiResource";
import { APITrackerPinsSection } from "./admin/APITrackerPinsSection";
import { ArtistGridPinsSection } from "./admin/ArtistGridPinsSection";
import { FilenPinsSection } from "./admin/FilenPinsSection";
import { MusicRootsSection } from "./admin/MusicRootsSection";
import { TidalSection } from "./admin/TidalSection";

/**
 * Section for the unified Admin page. Manages music roots + ArtistGrid trackers
 * + Filen shares. Does not render an outer `.view` wrapper or page title — the
 * parent page provides those. The three sub-sections share a single error
 * banner and the configured-roots list (used to populate the pin source
 * pickers).
 */
export function LibraryAdminSection() {
  const {
    data: roots,
    error: loadError,
    reload: reloadRoots,
  } = useApiResource<MusicRoot[]>(
    () => api.listMusicRoots(),
    "Failed to load roots.",
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;

  const onError = useCallback((message: string) => {
    setActionError(message || null);
  }, []);

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
    <AdminPanel>
      <MusicRootsSection
        roots={roots}
        reloadRoots={reloadRoots}
        error={error}
        onError={onError}
      />
      <TidalSection />
      <APITrackerPinsSection
        rootOptions={rootOptions}
        defaultRootPath={defaultRootPath}
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
    </AdminPanel>
  );
}
