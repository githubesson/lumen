import { FormEvent, useState } from "react";
import { LinkIcon } from "@heroicons/react/16/solid";
import {
  api,
  errorMessage,
  type FilenDownload,
  type FilenPin,
} from "../../api";
import { Button } from "../../components/Button";
import { Field, TextInput } from "../../components/Field";
import { Select } from "../../components/Select";
import { AdminSectionIntro } from "./AdminSectionTitle";
import { DownloadHistoryTable, PinTable } from "./PinComponents";
import { usePinManager } from "./usePinManager";

type RootOption = { value: string; label: string; disabled: boolean };

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

  const [filenRootPath, setFilenRootPath] = useState("");
  const [filenURL, setFilenURL] = useState("");
  const [filenPassword, setFilenPassword] = useState("");
  const [filenDestinationSubdir, setFilenDestinationSubdir] = useState("");
  const [filenLabel, setFilenLabel] = useState("");
  const [filenScanMinutes, setFilenScanMinutes] = useState("60");
  const [addingFilenPin, setAddingFilenPin] = useState(false);

  const effectiveRootPath = filenRootPath || defaultRootPath;

  const addFilenPin = async (e: FormEvent) => {
    e.preventDefault();
    onError("");
    setAddingFilenPin(true);
    try {
      const interval = Math.max(5, Number.parseInt(filenScanMinutes, 10) || 60);
      await api.createFilenPin({
        root_path: effectiveRootPath,
        destination_subdir: filenDestinationSubdir.trim(),
        share_url: filenURL.trim(),
        password: filenPassword,
        label: filenLabel.trim(),
        scan_interval_seconds: interval * 60,
      });
      setFilenURL("");
      setFilenPassword("");
      setFilenDestinationSubdir("");
      setFilenLabel("");
      setFilenScanMinutes("60");
      await manager.reload();
    } catch (err) {
      onError(errorMessage(err, "Failed to pin Filen share."));
    } finally {
      setAddingFilenPin(false);
    }
  };

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

      <form
        onSubmit={addFilenPin}
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
          <Field label="Filen share URL" hint="File or folder public link">
            <TextInput
              value={filenURL}
              onChange={(e) => setFilenURL(e.target.value)}
              placeholder="https://drive.filen.io/f/..."
              required
            />
          </Field>
          <Field label="Source folder">
            <Select
              value={effectiveRootPath}
              onChange={setFilenRootPath}
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
          <Field label="Destination subfolder" hint="Relative to the selected source">
            <TextInput
              value={filenDestinationSubdir}
              onChange={(e) => setFilenDestinationSubdir(e.target.value)}
              placeholder="Filen"
            />
          </Field>
          <Field label="Password" hint="Optional">
            <TextInput
              type="password"
              value={filenPassword}
              onChange={(e) => setFilenPassword(e.target.value)}
              placeholder="Protected link password"
            />
          </Field>
          <Field label="Every" hint="Minutes">
            <TextInput
              type="number"
              min={5}
              step={5}
              value={filenScanMinutes}
              onChange={(e) => setFilenScanMinutes(e.target.value)}
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
                value={filenLabel}
                onChange={(e) => setFilenLabel(e.target.value)}
                placeholder="Filen share"
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            leadingIcon={<LinkIcon className="size-4" />}
            disabled={addingFilenPin || !filenURL.trim() || !effectiveRootPath}
          >
            {addingFilenPin ? "Pinning..." : "Pin share"}
          </Button>
        </div>
      </form>

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
              <div className="track-sub mono" style={{ wordBreak: "break-all" }}>
                {pin.share_url}
              </div>
              {pin.password_set && <div className="track-sub">password set</div>}
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
