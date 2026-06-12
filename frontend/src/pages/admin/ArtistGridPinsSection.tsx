import { FormEvent, useState } from "react";
import { LinkIcon } from "@heroicons/react/16/solid";
import {
  api,
  errorMessage,
  type ArtistGridDownload,
  type ArtistGridPin,
} from "../../api";
import { Button } from "../../components/Button";
import { Field, TextInput } from "../../components/Field";
import { Select } from "../../components/Select";
import { AdminSectionIntro } from "./AdminSectionTitle";
import { DownloadHistoryTable, PinTable } from "./PinComponents";
import { usePinManager } from "./usePinManager";

type RootOption = { value: string; label: string; disabled: boolean };

/**
 * ArtistGrid trackers: pin a tracker to a configured source folder, manage its
 * scan lifecycle, and inspect recent downloads.
 */
export function ArtistGridPinsSection({
  rootOptions,
  defaultRootPath,
  onError,
}: {
  rootOptions: RootOption[];
  defaultRootPath: string;
  onError: (message: string) => void;
}) {
  const manager = usePinManager<ArtistGridPin, ArtistGridDownload>({
    list: () => api.listArtistGridPins(),
    update: (id, patch) => api.updateArtistGridPin(id, patch),
    remove: (id) => api.deleteArtistGridPin(id),
    scan: (id) => api.scanArtistGridPin(id),
    listDownloads: (id, limit) => api.listArtistGridDownloads(id, limit),
    kind: "tracker",
    confirmRemove: (pin) =>
      `Remove tracker pin ${pin.label || pin.tracker_id}?\n\nDownloaded files stay on disk and remain in the library.`,
    onError,
  });

  const [pinRootPath, setPinRootPath] = useState("");
  const [tracker, setTracker] = useState("");
  const [destinationSubdir, setDestinationSubdir] = useState("");
  const [trackerTab, setTrackerTab] = useState("");
  const [pinLabel, setPinLabel] = useState("");
  const [primaryArtist, setPrimaryArtist] = useState("");
  const [scanMinutes, setScanMinutes] = useState("60");
  const [addingPin, setAddingPin] = useState(false);

  const effectiveRootPath = pinRootPath || defaultRootPath;

  const addPin = async (e: FormEvent) => {
    e.preventDefault();
    onError("");
    setAddingPin(true);
    try {
      const interval = Math.max(5, Number.parseInt(scanMinutes, 10) || 60);
      await api.createArtistGridPin({
        root_path: effectiveRootPath,
        destination_subdir: destinationSubdir.trim(),
        tracker: tracker.trim(),
        tab: trackerTab.trim(),
        label: pinLabel.trim(),
        primary_artist: primaryArtist.trim(),
        scan_interval_seconds: interval * 60,
      });
      setTracker("");
      setDestinationSubdir("");
      setTrackerTab("");
      setPinLabel("");
      setPrimaryArtist("");
      setScanMinutes("60");
      await manager.reload();
    } catch (err) {
      onError(errorMessage(err, "Failed to pin ArtistGrid tracker."));
    } finally {
      setAddingPin(false);
    }
  };

  const historyPin = manager.historyPinID
    ? manager.pins?.find((pin) => pin.id === manager.historyPinID)
    : undefined;
  const historyRows = manager.historyPinID
    ? manager.downloadsByPin[manager.historyPinID]
    : undefined;

  return (
    <section aria-labelledby="artistgrid-pins" style={{ display: "grid", gap: 14 }}>
      <AdminSectionIntro
        id="artistgrid-pins"
        title="ArtistGrid trackers"
        description="Pin trackers to folders that are already configured as sources. Scans download only missing files; existing files are recorded and ingested in place."
      />

      <form
        onSubmit={addPin}
        className="surface"
        style={{ padding: 20, display: "grid", gap: 14 }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 12,
          }}
        >
          <Field label="Tracker URL or ID" hint="ArtistGrid tracker link or raw tracker id">
            <TextInput
              value={tracker}
              onChange={(e) => setTracker(e.target.value)}
              placeholder="https://artistgrid.cx/..."
              required
            />
          </Field>
          <Field label="Source folder">
            <Select
              value={effectiveRootPath}
              onChange={setPinRootPath}
              options={rootOptions}
              placeholder="Select source folder"
              disabled={!rootOptions.length}
            />
          </Field>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          <Field label="Destination subfolder" hint="Relative to the selected source">
            <TextInput
              value={destinationSubdir}
              onChange={(e) => setDestinationSubdir(e.target.value)}
              placeholder="ArtistGrid"
            />
          </Field>
          <Field label="Tab" hint="Optional">
            <TextInput
              value={trackerTab}
              onChange={(e) => setTrackerTab(e.target.value)}
              placeholder="Leaks"
            />
          </Field>
          <Field label="Primary artist" hint="Optional override">
            <TextInput
              value={primaryArtist}
              onChange={(e) => setPrimaryArtist(e.target.value)}
              placeholder="Artist"
            />
          </Field>
          <Field label="Every" hint="Minutes">
            <TextInput
              type="number"
              min={5}
              step={5}
              value={scanMinutes}
              onChange={(e) => setScanMinutes(e.target.value)}
            />
          </Field>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "end",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: "1 1 260px" }}>
            <Field label="Label" hint="Optional display name">
              <TextInput
                value={pinLabel}
                onChange={(e) => setPinLabel(e.target.value)}
                placeholder="ArtistGrid tracker"
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            leadingIcon={<LinkIcon className="size-4" />}
            disabled={addingPin || !tracker.trim() || !effectiveRootPath}
          >
            {addingPin ? "Pinning..." : "Pin tracker"}
          </Button>
        </div>
      </form>

      <PinTable
        manager={manager}
        nameHeader="Tracker"
        emptyLabel="No tracker pins yet."
        rowKey={(pin) =>
          (pin.id?.trim() ?? "") || `${pin.tracker_id}:${pin.destination_path}`
        }
        renderLead={(pin) => (
          <>
            <td>
              <div className="track-title">{pin.label || pin.tracker_id}</div>
              <div className="track-sub mono">
                {pin.tracker_id}
                {pin.tab ? ` / ${pin.tab}` : ""}
              </div>
            </td>
            <td className="mono" style={{ wordBreak: "break-all" }}>
              {pin.destination_path}
              {!pin.root_exists && (
                <span
                  title="The pinned source root does not exist on the server"
                  style={{
                    marginLeft: 8,
                    color: "var(--warning-fg)",
                    fontSize: 11,
                  }}
                >
                  missing
                </span>
              )}
            </td>
          </>
        )}
      />

      {manager.historyPinID && (
        <DownloadHistoryTable
          title={historyPin?.label || historyPin?.tracker_id || "Tracker"}
          rows={historyRows}
          sourceField="source_url"
          onRefresh={() =>
            manager.historyPinID && manager.loadDownloads(manager.historyPinID)
          }
        />
      )}
    </section>
  );
}
