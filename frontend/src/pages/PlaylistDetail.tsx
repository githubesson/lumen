import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  LockClosedIcon,
  MusicalNoteIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
} from "@heroicons/react/16/solid";
import {
  api,
  errorMessage,
  toQueueItem,
  type Collaborator,
  type Playlist,
  type TrackListItem,
} from "../api";
import { usePlayer } from "../context/Player";
import { Button } from "../components/Button";
import { Select } from "../components/Select";
import SegmentedControl, {
  type SegmentedOption,
} from "../components/SegmentedControl";
import SearchInput from "../components/SearchInput";
import ListPageHeader from "../components/ListPageHeader";
import ErrorBanner from "../components/ErrorBanner";
import LoadingState from "../components/LoadingState";
import { useFavorites } from "../context/Favorites";
import { useKey } from "../lib/keybindings";
import { fmtTotalMs } from "../lib/format";
import { swatchFor } from "../lib/swatch";
import CollaboratorsPanel from "./playlist/CollaboratorsPanel";
import AddTracksDialog from "./playlist/AddTracksDialog";
import EditPlaylistDialog from "./playlist/EditPlaylistDialog";
import PlaylistTracksPanel from "./playlist/PlaylistTracksPanel";
import {
  SORT_DEFAULT_ASC,
  SORT_OPTIONS,
  compareEntries,
  type SortKey,
} from "./playlist/trackSort";
import type { PlaylistTrackEntry } from "../api";

type Tab = "tracks" | "collaborators";
const PLAYLIST_SELECTION_CONTROLS_ID = "playlist-track-selection-controls";

export default function PlaylistDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { play, current, isPlaying } = usePlayer();
  const { isFavorite, toggle: toggleFav } = useFavorites();

  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrackEntry[] | null>(null);
  const [collabs, setCollabs] = useState<Collaborator[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tracks");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("custom");
  const [sortAsc, setSortAsc] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useKey(
    "mod+f",
    (e) => {
      e.preventDefault();
      setTab("tracks");
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    },
    {
      id: "playlist:search",
      label: "Search in playlist",
      group: "Playlist",
      allowInInput: true,
    },
  );

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const p = await api.getPlaylist(id);
      setPlaylist(p);
      const t = await api.listPlaylistTracks(id);
      setTracks(t.tracks);
      if (p.effective_role === "owner" || p.visibility === "collaborative") {
        const c = await api.listCollaborators(id).catch(() => []);
        setCollabs(c);
      }
    } catch (err) {
      setError(errorMessage(err, "Failed to load playlist."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // All hooks must run unconditionally — keep them above every early return so
  // an error/loading state never changes the hook count between renders.
  // What the table shows; the play queue follows this order too.
  const sortedTracks = useMemo(() => {
    const base = tracks ?? [];
    if (sortKey === "custom") return base;
    const sorted = [...base].sort((a, b) => compareEntries(a, b, sortKey));
    return sortAsc ? sorted : sorted.reverse();
  }, [tracks, sortKey, sortAsc]);
  const queue = useMemo(() => sortedTracks.map(toQueueItem), [sortedTracks]);
  const queueById = useMemo(() => {
    const map = new Map<string, TrackListItem>();
    for (const item of queue) map.set(item.id, item);
    return map;
  }, [queue]);
  // Header art follows the saved order so re-sorting doesn't swap the cover.
  const firstCoverTrack = useMemo(() => {
    const base = tracks ?? [];
    const entry = base.find((t) => t.album_id) ?? base[0];
    return entry ? toQueueItem(entry) : null;
  }, [tracks]);
  const q = searchQuery.trim().toLowerCase();
  const filteredTracks = useMemo(
    () =>
      q
        ? sortedTracks.filter((t) =>
            `${t.title} ${t.artist ?? ""} ${t.album_title ?? ""}`
              .toLowerCase()
              .includes(q),
          )
        : sortedTracks,
    [sortedTracks, q],
  );

  if (error) {
    return (
      <div className="view">
        <ErrorBanner message={error} />
      </div>
    );
  }

  if (!playlist || tracks === null) {
    return <LoadingState />;
  }

  const role = playlist.effective_role ?? "";
  const isOwner = role === "owner";
  const canEdit = isOwner || role === "editor";

  const onPlayAll = () => {
    if (queue.length > 0) play(queue[0], queue);
  };

  const onRemove = async (position: number) => {
    if (!id) return;
    try {
      await api.removePlaylistTrack(id, position);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to remove track."));
    }
  };

  const onDelete = async () => {
    if (!id || !window.confirm(`Delete "${playlist.name}"? This cannot be undone.`)) return;
    try {
      await api.deletePlaylist(id);
      navigate("/playlists", { replace: true });
    } catch (err) {
      setError(errorMessage(err, "Failed to delete."));
    }
  };

  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <ListPageHeader
        kind={
          <>
            {playlist.visibility === "collaborative" ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <UsersIcon className="size-3" /> Collaborative
              </span>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <LockClosedIcon className="size-3" /> Private
              </span>
            )}
            {role && role !== "owner" && (
              <>
                <span style={{ margin: "0 8px" }}>·</span>
                <span>{role}</span>
              </>
            )}
          </>
        }
        title={playlist.name}
        description={playlist.description || undefined}
        heroTrack={firstCoverTrack}
        fallbackGradient={swatchFor(playlist.id)}
        fallbackIcon={
          <MusicalNoteIcon className="size-12" style={{ color: "var(--accent-fg)" }} />
        }
        meta={
          <>
            <span>
              {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
            </span>
            {tracks.length > 0 && (
              <>
                <span className="dot" />
                <span>{fmtTotalMs(tracks.reduce((s, t) => s + t.duration_ms, 0))}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <Button
              variant="primary"
              onClick={onPlayAll}
              disabled={tracks.length === 0}
              leadingIcon={<PlayIcon className="size-4" />}
            >
              Play all
            </Button>
            {canEdit && (
              <Button
                onClick={() => setShowAddDialog(true)}
                leadingIcon={<PlusIcon className="size-4" />}
              >
                Add tracks
              </Button>
            )}
            {isOwner && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setShowEditDialog(true)}
                  leadingIcon={<PencilSquareIcon className="size-4" />}
                >
                  Edit
                </Button>
                <Button
                  variant="danger"
                  onClick={onDelete}
                  leadingIcon={<TrashIcon className="size-4" />}
                >
                  Delete
                </Button>
              </>
            )}
          </>
        }
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            { value: "tracks", label: "Tracks" },
            ...(playlist.visibility === "collaborative" || isOwner
              ? [
                  {
                    value: "collaborators",
                    label: (
                      <>
                        Collaborators
                        {collabs.length > 0 && (
                          <span
                            className="mono"
                            style={{ color: "var(--fg-subtle)", marginLeft: 4 }}
                          >
                            {collabs.length}
                          </span>
                        )}
                      </>
                    ),
                  } satisfies SegmentedOption<Tab>,
                ]
              : []),
          ]}
        />
        <div style={{ flex: 1 }} />
        {tab === "tracks" && tracks.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div
              id={PLAYLIST_SELECTION_CONTROLS_ID}
              className="track-selectbar-host"
            />
            <Select
              value={sortKey}
              onChange={(next) => {
                if (next !== sortKey) setSortAsc(SORT_DEFAULT_ASC[next]);
                setSortKey(next);
              }}
              options={SORT_OPTIONS}
              variant="minimal"
              aria-label="Sort playlist"
            />
            {sortKey !== "custom" && (
              <Button
                variant="ghost"
                style={{ paddingInline: 8 }}
                onClick={() => setSortAsc((asc) => !asc)}
                aria-label={
                  sortAsc
                    ? "Sorted ascending, switch to descending"
                    : "Sorted descending, switch to ascending"
                }
              >
                {sortAsc ? (
                  <ArrowUpIcon className="size-3.5" />
                ) : (
                  <ArrowDownIcon className="size-3.5" />
                )}
              </Button>
            )}
          </div>
        )}
        <SearchInput
          ref={searchInputRef}
          style={{ width: 260 }}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onClear={() => setSearchQuery("")}
          placeholder="Search this playlist"
          aria-label="Search this playlist"
        />
      </div>

      {tab === "tracks" && (
        <PlaylistTracksPanel
          tracks={filteredTracks}
          totalCount={tracks.length}
          searchActive={q.length > 0}
          searchQuery={searchQuery}
          queue={queue}
          queueById={queueById}
          canEdit={canEdit}
          onRemove={onRemove}
          onPlay={(entry) => {
            const item = queueById.get(entry.track_id);
            if (item) play(item, queue);
          }}
          onToggleFav={(id) => void toggleFav(id)}
          isFav={isFavorite}
          isCurrent={(tid) => current?.id === tid}
          isPlaying={isPlaying}
          selectionControlsHostId={PLAYLIST_SELECTION_CONTROLS_ID}
        />
      )}

      {tab === "collaborators" && (
        <CollaboratorsPanel
          playlistId={id!}
          collaborators={collabs}
          isOwner={isOwner}
          canInvite={isOwner && playlist.visibility === "collaborative"}
          onChanged={load}
        />
      )}

      {id && (
        <AddTracksDialog
          open={showAddDialog}
          playlistId={id}
          existingIds={new Set(tracks.map((t) => t.track_id))}
          onClose={() => setShowAddDialog(false)}
          onAdded={async () => {
            setShowAddDialog(false);
            await load();
          }}
        />
      )}

      {id && (
        <EditPlaylistDialog
          open={showEditDialog}
          playlist={playlist}
          onClose={() => setShowEditDialog(false)}
          onSaved={async () => {
            setShowEditDialog(false);
            await load();
          }}
        />
      )}
    </div>
  );
}
