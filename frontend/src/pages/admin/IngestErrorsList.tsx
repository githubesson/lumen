import { memo } from "react";
import type { IngestErrors } from "../../api";
import Disclosure from "../../components/admin/Disclosure";

export const INGEST_ERRORS_ID = "ingest-errors";

/** Folder and file name, for either separator (the server may run on Windows). */
function splitPath(path: string): { dir: string; name: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut), name: path.slice(cut + 1) };
}

// One formatter for every row, where `toLocaleString` would set one up per
// call. Same fields and bad-date fallback as `formatDate` in ./format.
const lastTriedFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatLastTried(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : lastTriedFormat.format(date);
}

/**
 * Files that failed to import, behind a collapsed toggle: the latest error per
 * file and how many times it has failed. Renders nothing while there are none.
 * Memoized because its section re-renders every second while a rescan runs;
 * keep its props stable (the fetched list, a boolean and a state setter).
 */
export const IngestErrorsList = memo(function IngestErrorsList({
  data,
  open,
  onOpenChange,
}: {
  data: IngestErrors | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!data || data.total === 0) return null;
  const { errors, total } = data;
  return (
    <Disclosure
      id={INGEST_ERRORS_ID}
      label="Files that failed to import"
      count={total > errors.length ? `${errors.length} of ${total}` : total}
      open={open}
      onOpenChange={onOpenChange}
    >
      <table className="table table-static">
        <thead>
          <tr>
            <th>File</th>
            <th>Error</th>
            <th>Last tried</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e) => {
            const { dir, name } = splitPath(e.file_path);
            return (
              <tr key={e.id}>
                <td>
                  <div className="track-title" style={{ wordBreak: "break-all" }}>
                    {name}
                  </div>
                  {dir && (
                    <div className="track-sub font-mono" style={{ wordBreak: "break-all" }}>
                      {dir}
                    </div>
                  )}
                </td>
                <td>
                  <div style={{ color: "var(--destructive)", fontSize: 12 }}>{e.error}</div>
                  {e.attempts > 1 && (
                    <div className="track-sub">Failed {e.attempts} times</div>
                  )}
                </td>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>
                  {formatLastTried(e.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Disclosure>
  );
});
