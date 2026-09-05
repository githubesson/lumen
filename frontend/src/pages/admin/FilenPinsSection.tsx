import { useState } from "react";
import { api, type FilenDownload, type FilenPin } from "../../api";
import { Field, TextInput } from "../../components/Field";
import { AdminSectionIntro } from "./AdminSectionTitle";
import {
  DownloadHistoryTable,
  PinTable,
  PinDestinationCell,
} from "./PinComponents";
import { usePinManager } from "./usePinManager";
import { PinCreateForm, usePinForm, type RootOption } from "./PinCreateForm";

/**
 * Filen shares: pin a Filen file/folder link to a configured source folder and
 * manage its scan lifecycle + download history.
 */
export function FilenPinsSection({
  rootOptions,
  defaultRootPath,
  onError,
}: {
  rootOptions: RootOption[];
  defaultRootPath: string;
  onError: (message: string) => void;
}) {
  const manager = usePinManager<FilenPin, FilenDownload>({
    list: () => api.listFilenPins(),
    update: (id, patch) => api.updateFilenPin(id, patch),
    remove: (id) => api.deleteFilenPin(id),
    scan: (id) => api.scanFilenPin(id),
    listDownloads: (id, limit) => api.listFilenDownloads(id, limit),
    kind: "Filen share",
    confirmRemove: (pin) =>
      `Remove Filen share ${pin.label || pin.share_url}?\n\nDownloaded files stay on disk and remain in the library.`,
    onError,
  });

  const [filenURL, setFilenURL] = useState("");
  const [filenPassword, setFilenPassword] = useState("");
  const form = usePinForm({
    defaultRootPath,
    create: (common) =>
      api.createFilenPin({
        ...common,
        share_url: filenURL.trim(),
        password: filenPassword,
      }),
    reset: () => {
      setFilenURL("");
      setFilenPassword("");
    },
    reload: manager.reload,
    onError,
    failureMessage: "Failed to pin Filen share.",
  });

  const historyPin = manager.historyPinID
    ? manager.pins?.find((pin) => pin.id === manager.historyPinID)
    : undefined;
  const historyRows = manager.historyPinID
    ? manager.downloadsByPin[manager.historyPinID]
    : undefined;

  return (
    <section aria-labelledby="filen-pins" style={{ display: "grid", gap: 14 }}>
      <AdminSectionIntro
        id="filen-pins"
        title="Filen shares"
        description="Pin Filen file or folder links to configured sources. Passwords are optional and only used by the backend scanner."
      />

      <PinCreateForm
        form={form}
        rootOptions={rootOptions}
        destinationPlaceholder="Filen"
        labelPlaceholder="Filen share"
        submitLabel="Pin share"
        hasSource={!!filenURL.trim()}
        sourceField={
          <Field label="Filen share URL" hint="File or folder public link">
            <TextInput
              value={filenURL}
              onChange={(e) => setFilenURL(e.target.value)}
              placeholder="https://drive.filen.io/f/..."
              required
            />
          </Field>
        }
      >
        <Field label="Password" hint="Optional">
          <TextInput
            type="password"
            value={filenPassword}
            onChange={(e) => setFilenPassword(e.target.value)}
            placeholder="Protected link password"
          />
        </Field>
      </PinCreateForm>

      <PinTable
        manager={manager}
        nameHeader="Share"
        emptyLabel="No Filen shares yet."
        rowKey={(pin) =>
          (pin.id?.trim() ?? "") || `${pin.share_url}:${pin.destination_path}`
        }
        renderLead={(pin) => (
          <>
            <td>
              <div className="track-title">{pin.label || "Filen share"}</div>
              <div
                className="track-sub mono"
                style={{ wordBreak: "break-all" }}
              >
                {pin.share_url}
              </div>
              {pin.password_set && (
                <div className="track-sub">password set</div>
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
          title={historyPin?.label || "Filen share"}
          rows={historyRows}
          sourceField="source_path"
          onRefresh={() =>
            manager.historyPinID && manager.loadDownloads(manager.historyPinID)
          }
        />
      )}
    </section>
  );
}
