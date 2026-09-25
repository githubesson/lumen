/** An on/off toggle for settings that take effect as soon as they flip. */
export default function Switch({
  checked,
  onChange,
  disabled,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  // Labelled by visible text rather than aria-label, which would also give
  // the switch a hover tooltip (see TitleTooltips).
  "aria-labelledby": string;
  "aria-describedby"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}
