import { Link } from "react-router-dom";
import { PlusIcon } from "@heroicons/react/16/solid";
import { api, type Playlist } from "../api";
import PageHeader from "../components/PageHeader";
import PlaylistCard from "../components/PlaylistCard";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import LoadingState from "../components/LoadingState";
import { useApiResource } from "../lib/useApiResource";
import { pluralize } from "../lib/format";

export default function Playlists() {
  const { data: rows, error } = useApiResource<Playlist[]>(
    (signal) => api.listPlaylists({ signal }),
    [],
    "Failed to load playlists.",
  );

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

      {error && <ErrorBanner message={error} />}

      {rows === null && !error && <LoadingState />}

      {rows && rows.length === 0 && (
        <EmptyState
          className="mt-7"
          title="No playlists yet."
          hint="Create one to start collecting tracks."
        />
      )}

      {rows && rows.length > 0 && (
        <div className="grid-cards" style={{ marginTop: 20 }}>
          {rows.map((p) => (
            <PlaylistCard key={p.id} playlist={p} />
          ))}
        </div>
      )}
    </div>
  );
}
