import { useState } from "react";
import { api, type APITrackerDownload, type APITrackerPin } from "../../api";
import { Field, TextInput } from "../../components/Field";
import { AdminSectionIntro } from "./AdminSectionTitle";
import {
  DownloadHistoryTable,
  PinTable,
  PinDestinationCell,
} from "./PinComponents";
import { usePinManager } from "./usePinManager";
import {
  PinCreateForm,
  usePinForm,
  type RootOption,
  TrackerFields,
} from "./PinCreateForm";

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

  const [tracker, setTracker] = useState("");
  const [tab, setTab] = useState("");
  const [primaryArtist, setPrimaryArtist] = useState("");
  const [apiBaseURL, setApiBaseURL] = useState("");
  const form = usePinForm({
    defaultRootPath,
    create: (common) =>
      api.createAPITrackerPin({
        ...common,
        tracker: tracker.trim(),
        tab: tab.trim(),
        primary_artist: primaryArtist.trim(),
        api_base_url: apiBaseURL.trim(),
      }),
    reset: () => {
      setTracker("");
      setTab("");
      setPrimaryArtist("");
      setApiBaseURL("");
    },
    reload: manager.reload,
    onError,
    failureMessage: "Failed to pin API tracker.",
  });

  const historyPin = manager.historyPinID
    ? manager.pins?.find((pin) => pin.id === manager.historyPinID)
    : undefined;
  const historyRows = manager.historyPinID
    ? manager.downloadsByPin[manager.historyPinID]
    : undefined;

  return (
    <section
      aria-labelledby="api-tracker-pins"
      style={{ display: "grid", gap: 14 }}
    >
      <AdminSectionIntro
        id="api-tracker-pins"
        title="API trackers"
        description="Pin Tracker API catalogs to configured sources. Scans pull linked audio from tracker entries and ingest downloaded files into the library."
      />

      <PinCreateForm
        form={form}
        rootOptions={rootOptions}
        destinationPlaceholder="API Trackers"
        labelPlaceholder="API tracker"
        submitLabel="Pin tracker"
        hasSource={!!tracker.trim()}
        beforeDestination={
          <Field label="API base URL" hint="Optional">
            <TextInput
              value={apiBaseURL}
              onChange={(e) => setApiBaseURL(e.target.value)}
              placeholder="https://trackers.musicfiles.su/api"
            />
          </Field>
        }
        sourceField={
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
        }
      >
        <TrackerFields
          tab={tab}
          setTab={setTab}
          primaryArtist={primaryArtist}
          setPrimaryArtist={setPrimaryArtist}
          tabHint="Optional sheet name"
        />
      </PinCreateForm>

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
              <div
                className="track-sub mono"
                style={{ wordBreak: "break-all" }}
              >
                {pin.api_base_url}/v1/trackers/{pin.tracker_id}
              </div>
              {pin.tab && <div className="track-sub">Tab: {pin.tab}</div>}
              {pin.primary_artist && (
                <div className="track-sub">{pin.primary_artist}</div>
              )}
            </td>
            <PinDestinationCell
              path={pin.destination_path}
              rootExists={pin.root_exists}
            />
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
