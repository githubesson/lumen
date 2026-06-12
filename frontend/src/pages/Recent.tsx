import { useMemo } from "react";
import { ClockIcon, PlayIcon } from "@heroicons/react/16/solid";
import { api, type TrackListItem } from "../api";
import { Button } from "../components/Button";
import TrackList from "../components/TrackList";
import ListPageHeader from "../components/ListPageHeader";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import { usePlayer } from "../context/Player";
import { useApiResource } from "../lib/useApiResource";
import { pluralize } from "../lib/format";

export default function Recent() {
  const { play } = usePlayer();
  const { data: tracks, error } = useApiResource<TrackListItem[]>(
    (signal) => api.listRecent(100, { signal }),
    [],
    "Failed to load recent plays.",
  );

  const hero = useMemo(() => tracks?.[0] ?? null, [tracks]);

  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <ListPageHeader
        kind="Recent"
        title="Recently played"
        heroTrack={hero}
        fallbackIcon={
          <ClockIcon className="size-12" style={{ color: "var(--accent-fg)" }} />
        }
        meta={
          <>
            <span>{tracks ? pluralize(tracks.length, "track") : "—"}</span>
            <span className="dot" />
            <span>each track once, most recent first</span>
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
              title="Nothing played yet."
              hint="Play some tracks from the library and they'll show up here."
            />
          }
        />
      )}
    </div>
  );
}
