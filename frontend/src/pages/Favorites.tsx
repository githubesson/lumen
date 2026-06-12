import { useMemo } from "react";
import { HeartIcon, PlayIcon } from "@heroicons/react/16/solid";
import { api, type TrackListItem } from "../api";
import { Button } from "../components/Button";
import TrackList from "../components/TrackList";
import ListPageHeader from "../components/ListPageHeader";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import { usePlayer } from "../context/Player";
import { useApiResource } from "../lib/useApiResource";
import { pluralize } from "../lib/format";

export default function Favorites() {
  const { play } = usePlayer();
  const { data: tracks, error } = useApiResource<TrackListItem[]>(
    (signal) => api.listFavorites({ signal }),
    [],
    "Failed to load favorites.",
  );

  const hero = useMemo(() => tracks?.[0] ?? null, [tracks]);

  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <ListPageHeader
        kind="Collection"
        title="Favorites"
        heroTrack={hero}
        fallbackGradient="linear-gradient(135deg, color-mix(in oklch, var(--accent) 40%, var(--bg-elev-2)), var(--bg-elev-3))"
        fallbackIcon={
          <HeartIcon className="size-12" style={{ color: "var(--accent-fg)" }} />
        }
        meta={
          <>
            <span>{tracks ? pluralize(tracks.length, "track") : "—"}</span>
            <span className="dot" />
            <span>most recently favorited first</span>
          </>
        }
        actions={
          <Button
            variant="primary"
            disabled={!tracks || tracks.length === 0}
            onClick={() => tracks && tracks.length > 0 && play(tracks[0], tracks)}
            leadingIcon={<PlayIcon className="size-4" />}
          >
            Play all
          </Button>
        }
      />

      {error && <ErrorBanner message={error} />}
      {tracks && (
        <TrackList
          tracks={tracks}
          emptyState={
            <EmptyState
              title="No favorites yet."
              hint="Click the heart next to any track to add it here."
            />
          }
        />
      )}
    </div>
  );
}
