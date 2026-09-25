import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Plus as PlusIcon } from "lucide-react";
import PageHeader from "../components/PageHeader";
import PlaylistCard from "../components/PlaylistCard";
import EmptyState from "../components/EmptyState";
import DataState from "../components/DataState";
import { usePlaylists } from "../context/Playlists";
import { pluralize } from "../lib/format";

export default function Playlists() {
  // The sidebar already holds the list: show it at once and refresh it (and
  // the sidebar with it) behind.
  const { data: rows, error, reload } = usePlaylists();
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="view">
      <PageHeader
        title="Playlists"
        count={rows ? pluralize(rows.length, "list") : "—"}
        actions={
          <Link to="/playlists/new" className="btn btn-primary">
            <PlusIcon className="size-4" />
            New playlist
          </Link>
        }
      />

      <DataState
        data={rows}
        error={error}
        empty={(data) => data.length === 0}
        emptyState={
          <EmptyState
            className="mt-7"
            title="No playlists yet."
            hint="Create one to start collecting tracks."
          />
        }
      >
        {(playlists) => (
          <div className="grid-cards" style={{ marginTop: 20 }}>
            {playlists.map((p) => (
              <PlaylistCard key={p.id} playlist={p} />
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}
