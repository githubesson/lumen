/**
 * The mono "N of M units" / "M units" / "N units" line shown beneath a
 * library toolbar. Extracted from the duplicated inline copy in Library's
 * tracks/albums/artists views.
 */
export default function ListMeta({
  loaded,
  total,
  unit,
}: {
  loaded: number;
  total: number | null;
  unit: string;
}) {
  const plural = loaded === 1 ? unit : `${unit}s`;
  const text =
    total !== null && total > loaded
      ? `${loaded.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? unit : `${unit}s`}`
      : total !== null
        ? `${total.toLocaleString()} ${total === 1 ? unit : `${unit}s`}`
        : `${loaded.toLocaleString()} ${plural}`;
  return (
    <div
      className="mono"
      style={{
        marginTop: 14,
        color: "var(--fg-subtle)",
        fontSize: 11,
      }}
    >
      {text}
    </div>
  );
}
