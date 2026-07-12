export default function IosSpinner({
  className,
  label = "Loading",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={"ios-spinner" + (className ? ` ${className}` : "")}
      role="status"
      aria-label={label}
    >
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} style={{ ["--i" as string]: i }} />
      ))}
    </div>
  );
}
