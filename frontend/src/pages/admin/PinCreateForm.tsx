import { useState, type FormEvent, type ReactNode } from "react";
import { LinkIcon } from "@heroicons/react/16/solid";
import { errorMessage } from "../../api";
import { Button } from "../../components/Button";
import { Field, TextInput } from "../../components/Field";
import { Select } from "../../components/Select";

export type RootOption = { value: string; label: string; disabled: boolean };
interface CommonPinInput {
  root_path: string;
  destination_subdir: string;
  label: string;
  scan_interval_seconds: number;
}

export function usePinForm({
  defaultRootPath,
  create,
  reset,
  reload,
  onError,
  failureMessage,
}: {
  defaultRootPath: string;
  create: (input: CommonPinInput) => Promise<unknown>;
  reset: () => void;
  reload: () => Promise<unknown>;
  onError: (message: string) => void;
  failureMessage: string;
}) {
  const [rootPath, setRootPath] = useState("");
  const [destinationSubdir, setDestinationSubdir] = useState("");
  const [label, setLabel] = useState("");
  const [scanMinutes, setScanMinutes] = useState("60");
  const [adding, setAdding] = useState(false);
  const effectiveRootPath = rootPath || defaultRootPath;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    onError("");
    setAdding(true);
    try {
      await create({
        root_path: effectiveRootPath,
        destination_subdir: destinationSubdir.trim(),
        label: label.trim(),
        scan_interval_seconds:
          Math.max(5, Number.parseInt(scanMinutes, 10) || 60) * 60,
      });
      reset();
      setDestinationSubdir("");
      setLabel("");
      setScanMinutes("60");
      await reload();
    } catch (error) {
      onError(errorMessage(error, failureMessage));
    } finally {
      setAdding(false);
    }
  };

  return {
    effectiveRootPath,
    setRootPath,
    destinationSubdir,
    setDestinationSubdir,
    label,
    setLabel,
    scanMinutes,
    setScanMinutes,
    adding,
    submit,
  };
}

export function PinCreateForm({
  form,
  rootOptions,
  sourceField,
  beforeDestination,
  children,
  destinationPlaceholder,
  labelPlaceholder,
  submitLabel,
  hasSource,
  fieldMinWidth = 160,
}: {
  form: ReturnType<typeof usePinForm>;
  rootOptions: RootOption[];
  sourceField: ReactNode;
  beforeDestination?: ReactNode;
  children?: ReactNode;
  destinationPlaceholder: string;
  labelPlaceholder: string;
  submitLabel: string;
  hasSource: boolean;
  fieldMinWidth?: number;
}) {
  return (
    <form
      onSubmit={form.submit}
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
        {sourceField}
        <Field label="Source folder">
          <Select
            value={form.effectiveRootPath}
            onChange={form.setRootPath}
            options={rootOptions}
            placeholder="Select source folder"
            disabled={!rootOptions.length}
          />
        </Field>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fit, minmax(${fieldMinWidth}px, 1fr))`,
          gap: 12,
        }}
      >
        {beforeDestination}
        <Field
          label="Destination subfolder"
          hint="Relative to the selected source"
        >
          <TextInput
            value={form.destinationSubdir}
            onChange={(e) => form.setDestinationSubdir(e.target.value)}
            placeholder={destinationPlaceholder}
          />
        </Field>
        {children}
        <Field label="Every" hint="Minutes">
          <TextInput
            type="number"
            min={5}
            step={5}
            value={form.scanMinutes}
            onChange={(e) => form.setScanMinutes(e.target.value)}
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
              value={form.label}
              onChange={(e) => form.setLabel(e.target.value)}
              placeholder={labelPlaceholder}
            />
          </Field>
        </div>
        <Button
          type="submit"
          variant="primary"
          leadingIcon={<LinkIcon className="size-4" />}
          disabled={form.adding || !hasSource || !form.effectiveRootPath}
        >
          {form.adding ? "Pinning..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function TrackerFields({
  tab,
  setTab,
  primaryArtist,
  setPrimaryArtist,
  tabHint = "Optional",
}: {
  tab: string;
  setTab: (value: string) => void;
  primaryArtist: string;
  setPrimaryArtist: (value: string) => void;
  tabHint?: string;
}) {
  return (
    <>
      <Field label="Tab" hint={tabHint}>
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
    </>
  );
}
