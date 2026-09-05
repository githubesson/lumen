import { useState } from "react";
import { api, type ArtistGridDownload, type ArtistGridPin } from "../../api";
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

  const [tracker, setTracker] = useState("");
  const [tab, setTab] = useState("");
  const [primaryArtist, setPrimaryArtist] = useState("");
  const form = usePinForm({
    defaultRootPath,
    create: (common) =>
      api.createArtistGridPin({
        ...common,
        tracker: tracker.trim(),
        tab: tab.trim(),
        primary_artist: primaryArtist.trim(),
      }),
    reset: () => {
      setTracker("");
      setTab("");
      setPrimaryArtist("");
    },
    reload: manager.reload,
    onError,
    failureMessage: "Failed to pin ArtistGrid tracker.",
  });

  const historyPin = manager.historyPinID
    ? manager.pins?.find((pin) => pin.id === manager.historyPinID)
    : undefined;
  const historyRows = manager.historyPinID
    ? manager.downloadsByPin[manager.historyPinID]
    : undefined;

  return (
    <section
      aria-labelledby="artistgrid-pins"
      style={{ display: "grid", gap: 14 }}
    >
      <AdminSectionIntro
        id="artistgrid-pins"
        title="ArtistGrid trackers"
        description="Pin trackers to folders that are already configured as sources. Scans download only missing files; existing files are recorded and ingested in place."
      />

      <PinCreateForm
        form={form}
        rootOptions={rootOptions}
        destinationPlaceholder="ArtistGrid"
        labelPlaceholder="ArtistGrid"
        submitLabel="Pin tracker"
        hasSource={!!tracker.trim()}
        fieldMinWidth={140}
        sourceField={
          <Field
            label="Tracker URL or ID"
            hint="ArtistGrid tracker link or raw tracker id"
          >
            <TextInput
              value={tracker}
              onChange={(e) => setTracker(e.target.value)}
              placeholder="https://artistgrid.cx/..."
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
        />
      </PinCreateForm>

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
            <PinDestinationCell
              path={pin.destination_path}
              rootExists={pin.root_exists}
            />
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
