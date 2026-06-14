import { FormEvent, useState } from "react";
import { LinkIcon } from "@heroicons/react/16/solid";
import {
  api,
  errorMessage,
  type APITrackerDownload,
  type APITrackerPin,
} from "../../api";
import { Button } from "../../components/Button";
import { Field, TextInput } from "../../components/Field";
import { Select } from "../../components/Select";
import { AdminSectionIntro } from "./AdminSectionTitle";
import { DownloadHistoryTable, PinTable } from "./PinComponents";
import { usePinManager } from "./usePinManager";

type RootOption = { value: string; label: string; disabled: boolean };

export function APITrackerPinsSection({
  rootOptions,
  defaultRootPath,
  onError,
}: {
  rootOptions: RootOption[];
  defaultRootPath: string;
  onError: (message: string) => void;
}) {
  const manager = usePinManager<APITrackerPin, APITrackerDownload>({
    list: () => api.listAPITrackerPins(),
    update: (id, patch) => api.updateAPITrackerPin(id, patch),
    remove: (id) => api.deleteAPITrackerPin(id),
    scan: (id) => api.scanAPITrackerPin(id),
    listDownloads: (id, limit) => api.listAPITrackerDownloads(id, limit),
    kind: "API tracker",
    confirmRemove: (pin) =>
      `Remove API tracker ${pin.label || pin.tracker_name || pin.tracker_id}?\n\nDownloaded files stay on disk and remain in the library.`,
    onError,
  });

  const [rootPath, setRootPath] = useState("");
  const [tracker, setTracker] = useState("");
  const [apiBaseURL, setApiBaseURL] = useState("");
  const [destinationSubdir, setDestinationSubdir] = useState("");
  const [tab, setTab] = useState("");
  const [label, setLabel] = useState("");
  const [primaryArtist, setPrimaryArtist] = useState("");
  const [scanMinutes, setScanMinutes] = useState("60");
  const [adding, setAdding] = useState(false);

  const effectiveRootPath = rootPath || defaultRootPath;

  const addPin = async (e: FormEvent) => {
    e.preventDefault();
    onError("");
    setAdding(true);
    try {
      const interval = Math.max(5, Number.parseInt(scanMinutes, 10) || 60);
      await api.createAPITrackerPin({
        root_path: effectiveRootPath,
        destination_subdir: destinationSubdir.trim(),
        api_base_url: apiBaseURL.trim(),
        tracker: tracker.trim(),
        tab: tab.trim(),
        label: label.trim(),
        primary_artist: primaryArtist.trim(),
        scan_interval_seconds: interval * 60,
      });
      setTracker("");
      setApiBaseURL("");
      setDestinationSubdir("");
      setTab("");
      setLabel("");
      setPrimaryArtist("");
      setScanMinutes("60");
      await manager.reload();
    } catch (err) {
      onError(errorMessage(err, "Failed to pin API tracker."));
    } finally {
      setAdding(false);
    }
  };

  const historyPin = manager.historyPinID
    ? manager.pins?.find((pin) => pin.id === manager.historyPinID)
    : undefined;
  const historyRows = manager.historyPinID
    ? manager.downloadsByPin[manager.historyPinID]
    : undefined;

  return (
    <section aria-labelledby="api-tracker-pins" style={{ display: "grid", gap: 14 }}>
      <AdminSectionIntro
        id="api-tracker-pins"
        title="API trackers"
        description="Pin Tracker API catalogs to configured sources. Scans pull linked audio from tracker entries and ingest downloaded files into the library."
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
          <Field
            label="Tracker URL or ID"
            hint="Tracker API /v1/trackers/:id link or raw id"
          >
            <TextInput
              value={tracker}
              onChange={(e) => setTracker(e.target.value)}
              placeholder="https://trackers.musicfiles.su/api/v1/trackers/1"
              required
            />
          </Field>
          <Field label="Source folder">
            <Select
              value={effectiveRootPath}
              onChange={setRootPath}
              options={rootOptions}
              placeholder="Select source folder"
              disabled={!rootOptions.length}
            />
          </Field>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 12,
          }}
        >
          <Field label="API base URL" hint="Optional">
            <TextInput
              value={apiBaseURL}
              onChange={(e) => setApiBaseURL(e.target.value)}
              placeholder="https://trackers.musicfiles.su/api"
            />
          </Field>
          <Field label="Destination subfolder" hint="Relative to the selected source">
            <TextInput
              value={destinationSubdir}
              onChange={(e) => setDestinationSubdir(e.target.value)}
              placeholder="API Trackers"
            />
          </Field>
          <Field label="Tab" hint="Optional sheet name">
            <TextInput
              value={tab}
              onChange={(e) => setTab(e.target.value)}
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
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="API tracker"
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            leadingIcon={<LinkIcon className="size-4" />}
            disabled={adding || !tracker.trim() || !effectiveRootPath}
          >
            {adding ? "Pinning..." : "Pin tracker"}
          </Button>
        </div>
      </form>

      <PinTable
        manager={manager}
        nameHeader="Tracker"
        emptyLabel="No API tracker pins yet."
        rowKey={(pin) =>
          (pin.id?.trim() ?? "") ||
          `${pin.api_base_url}:${pin.tracker_id}:${pin.destination_path}`
        }
        renderLead={(pin) => (
          <>
            <td>
              <div className="track-title">
                {pin.label || pin.tracker_name || `Tracker ${pin.tracker_id}`}
              </div>
              <div className="track-sub mono" style={{ wordBreak: "break-all" }}>
                {pin.api_base_url}/v1/trackers/{pin.tracker_id}
              </div>
              {pin.tab && <div className="track-sub">Tab: {pin.tab}</div>}
              {pin.primary_artist && (
                <div className="track-sub">{pin.primary_artist}</div>
              )}
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
          title={
            historyPin?.label ||
            historyPin?.tracker_name ||
            (historyPin ? `Tracker ${historyPin.tracker_id}` : "API tracker")
          }
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
