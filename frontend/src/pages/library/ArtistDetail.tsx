import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft as ArrowLeftIcon,
  Shuffle as ArrowsRightLeftIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
} from "lucide-react";
import {
  albumCoverUrl,
  api,
  errorMessage,
  resolveCoverUrl,
  trackCoverUrl,
  type Artist,
  type TidalArtist,
  type TrackListItem,
} from "../../api";
import {
  ARTIST_POPULAR_PREVIEW_COUNT,
  filterReleases,
  hasReleaseFilters,
  libraryArtistReleases,
  releaseSubtitle,
  tidalArtistReleases,
  type ArtistRelease,
  type ReleaseFilter,
} from "@music-library/core/artist-releases";
import { displayText, pluralize } from "../../lib/format";
import { useEntityDetail } from "../../lib/useEntityDetail";
import { usePlayer, useRemotePlayback } from "../../context/Player";
import { Button } from "../../components/Button";
import CoverArt from "../../components/CoverArt";
import EmptyState from "../../components/EmptyState";
import ErrorBanner from "../../components/ErrorBanner";
import LoadingState from "../../components/LoadingState";
import Section from "../../components/Section";
import TrackList from "../../components/TrackList";
import {
  DetailTrackSearchBar,
  NotFound,
  useDetailTrackSearch,
} from "./LibraryDetail";

const SHELF_LIMIT = 6;
const NO_TRACKS: TrackListItem[] = [];
const RELEASE_FILTERS: { key: ReleaseFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "albums", label: "Albums" },
  { key: "singles", label: "Singles and EPs" },
];

export function ArtistDetailView({
  id,
  onBack,
  onOpenAlbum,
}: {
  id: string;
  onBack: () => void;
  onOpenAlbum: (id: string) => void;
}) {
  const { entity: artist, tracks, error } = useEntityDetail<Artist>(id, {
    get: api.getArtist,
    listTracks: api.listArtistTracks,
    label: "artist",
  });
  const search = useDetailTrackSearch("artist", tracks);
  const releases = useMemo(
    () => libraryArtistReleases(tracks ?? NO_TRACKS),
    [tracks],
  );

  if (artist === "notfound") {
    return <NotFound kind="Artist" onBack={onBack} />;
  }
  // A failed load leaves both artist and tracks empty; without this the page
  // would sit on the loading state with no way back.
  if (error) {
    return (
      <div className="view artist-status">
        <ErrorBanner message={error} />
        <div>
          <Button
            variant="ghost"
            onClick={onBack}
            leadingIcon={<ArrowLeftIcon className="size-3.5" />}
          >
            Back to library
          </Button>
        </div>
      </div>
    );
  }
  if (!artist || !tracks) {
    return (
      <div className="view">
        <LoadingState label="Loading library…" />
      </div>
    );
  }
  return (
    <div className="view artist-page">
      <ArtistHero
        name={artist.name}
        imageUrl={tracks[0] ? trackCoverUrl(tracks[0]) : null}
        kind="Artist"
        meta={[
          pluralize(artist.track_count, "track"),
          artist.album_count > 0 && pluralize(artist.album_count, "album"),
        ]}
        backLabel="Library"
        onBack={onBack}
      />
      <ArtistActions name={artist.name} tracks={tracks}>
        <DetailTrackSearchBar
          kind="artist"
          query={search.query}
          onQueryChange={search.setQuery}
          inputRef={search.inputRef}
          matchCount={search.filteredTracks.length}
          totalCount={tracks.length}
          searchActive={search.searchActive}
        />
      </ArtistActions>
      {!search.searchActive && releases.length > 0 && (
        <Discography releases={releases} onOpen={onOpenAlbum} />
      )}
      <Section className="artist-section" title="Songs">
        <TrackList
          tracks={search.filteredTracks}
          queueSource={tracks}
          emptyState={
            search.searchActive ? (
              <EmptyState
                title="No matches."
                hint={`Nothing by this artist matches "${search.query}".`}
              />
            ) : undefined
          }
        />
      </Section>
    </div>
  );
}

export function TidalArtistDetailView({
  id,
  name,
  onBack,
  onOpenAlbum,
}: {
  id: string;
  /** Name from the link, shown until the loaded profile replaces it. */
  name: string;
  onBack: () => void;
  onOpenAlbum: (id: string) => void;
}) {
  const [data, setData] = useState<TidalArtist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [completedAttempt, setCompletedAttempt] = useState(-1);
  const loading = completedAttempt !== attempt;
  const warning = data?.warnings?.join(" ");
  const tracks = data?.tracks ?? NO_TRACKS;
  const releases = useMemo(
    () => (data ? tidalArtistReleases(data.albums) : []),
    [data],
  );
  const profile = data?.artist;
  const artistName = profile?.name || name;
  // Artists without a TIDAL picture borrow their top track's cover.
  const imageUrl = profile?.cover_url
    ? resolveCoverUrl(profile.cover_url)
    : tracks[0]
      ? trackCoverUrl(tracks[0])
      : null;
  useEffect(() => {
    const controller = new AbortController();
    api
      .getTidalArtist(id, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(errorMessage(err, "Couldn't load artist."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCompletedAttempt(attempt);
      });
    return () => controller.abort();
  }, [id, attempt]);
  return (
    <div className="view artist-page">
      <ArtistHero
        name={artistName}
        imageUrl={imageUrl}
        kind={
          <>
            Artist
            <span className="badge">TIDAL</span>
          </>
        }
        meta={
          data
            ? [
                releases.length > 0 && pluralize(releases.length, "release"),
                tracks.length > 0 && pluralize(tracks.length, "popular track"),
              ]
            : undefined
        }
        backLabel="Back to search"
        onBack={onBack}
      />
      <ArtistActions name={artistName} tracks={tracks} />
      {(error || warning) && (
        <div className="artist-status">
          {error && <ErrorBanner message={error} />}
          {warning && <ErrorBanner message={warning} />}
          <div>
            <Button
              disabled={loading}
              onClick={() => {
                setError(null);
                setAttempt((value) => value + 1);
              }}
            >
              {loading ? "Retrying…" : "Retry artist"}
            </Button>
          </div>
        </div>
      )}
      {!data && loading && <LoadingState label="Loading artist…" />}
      {data && (
        <>
          {tracks.length > 0 && <PopularTracks tracks={tracks} />}
          {releases.length > 0 && (
            <Discography releases={releases} onOpen={onOpenAlbum} />
          )}
          {!releases.length &&
            !tracks.length &&
            !warning &&
            !error &&
            !loading && <EmptyState title="No releases found." />}
        </>
      )}
    </div>
  );
}

function ArtistHero({
  name,
  imageUrl,
  kind,
  meta,
  backLabel,
  onBack,
}: {
  name: string;
  imageUrl: string | null;
  kind: ReactNode;
  meta?: (string | false)[];
  backLabel: string;
  onBack: () => void;
}) {
  const metaItems = meta?.filter((item): item is string => Boolean(item));
  return (
    <header className="artist-hero">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="artist-hero-back"
          onClick={onBack}
          leadingIcon={<ArrowLeftIcon className="size-3.5" />}
        >
          {backLabel}
        </Button>
      </div>
      <div className="artist-hero-main">
        <CoverArt
          className="artist-hero-avatar"
          src={imageUrl}
          label={name}
          radius={999}
          forcePlaceholder={!imageUrl}
        />
        <div className="artist-hero-body">
          <div className="artist-hero-kind">{kind}</div>
          <h1 className="artist-hero-name">{displayText(name)}</h1>
          {metaItems && metaItems.length > 0 && (
            <div className="artist-hero-meta">
              {metaItems.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function ArtistActions({
  name,
  tracks,
  children,
}: {
  name: string;
  tracks: TrackListItem[];
  children?: ReactNode;
}) {
  const { play, toggle, current, isPlaying, shuffle, toggleShuffle } =
    usePlayer();
  const { targetDevice, controlledShuffle, commandPending } =
    useRemotePlayback();
  const shownShuffle = targetDevice ? controlledShuffle : shuffle;
  // Without a play-context id, a current track from this artist's list is the
  // closest signal that the big button should pause instead of restarting.
  const playingHere =
    current != null && tracks.some((track) => track.id === current.id);
  const showPause = playingHere && isPlaying;
  const label = displayText(name);
  return (
    <div className="artist-actions">
      <button
        type="button"
        className="artist-play"
        disabled={tracks.length === 0}
        aria-label={showPause ? `Pause ${label}` : `Play ${label}`}
        onClick={() => {
          if (playingHere) {
            toggle();
            return;
          }
          const start = shownShuffle
            ? tracks[Math.floor(Math.random() * tracks.length)]
            : tracks[0];
          play(start, tracks);
        }}
      >
        {showPause ? (
          <PauseIcon className="size-6" />
        ) : (
          <PlayIcon className="size-6" />
        )}
      </button>
      <button
        type="button"
        className={"artist-shuffle" + (shownShuffle ? " active" : "")}
        aria-label="Shuffle"
        aria-pressed={shownShuffle}
        onClick={toggleShuffle}
        disabled={commandPending}
      >
        <ArrowsRightLeftIcon className="size-5" />
      </button>
      {children != null && <div className="artist-actions-end">{children}</div>}
    </div>
  );
}

function PopularTracks({ tracks }: { tracks: TrackListItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = useMemo(
    () => (expanded ? tracks : tracks.slice(0, ARTIST_POPULAR_PREVIEW_COUNT)),
    [expanded, tracks],
  );
  return (
    <Section className="artist-section" title="Popular">
      <TrackList
        tracks={shown}
        queueSource={tracks}
        showHeader={false}
        selectable={false}
        showSourceBadge={false}
      />
      {tracks.length > ARTIST_POPULAR_PREVIEW_COUNT && (
        <button
          type="button"
          className="artist-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "See more"}
        </button>
      )}
    </Section>
  );
}

function Discography({
  releases,
  onOpen,
}: {
  releases: ArtistRelease[];
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<ReleaseFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const shown = filterReleases(releases, filter);
  return (
    <Section
      className="artist-section"
      title="Discography"
      action={
        shown.length > SHELF_LIMIT && (
          <button
            type="button"
            className="artist-more"
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show less" : "Show all"}
          </button>
        )
      }
    >
      {hasReleaseFilters(releases) && (
        <div className="chips artist-chips">
          {RELEASE_FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={"chip" + (filter === option.key ? " active" : "")}
              aria-pressed={filter === option.key}
              onClick={() => setFilter(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      <div className={showAll ? "grid-cards" : "shelf"}>
        {shown.map((release) => (
          <ReleaseCard key={release.id} release={release} onOpen={onOpen} />
        ))}
      </div>
    </Section>
  );
}

function ReleaseCard({
  release,
  onOpen,
}: {
  release: ArtistRelease;
  onOpen: (id: string) => void;
}) {
  const src = release.cover_url
    ? resolveCoverUrl(release.cover_url)
    : release.has_cover !== false
      ? albumCoverUrl(release.id)
      : null;
  return (
    <button type="button" className="card" onClick={() => onOpen(release.id)}>
      <CoverArt
        className="card-art"
        src={src}
        label={release.title}
        forcePlaceholder={!src}
      />
      <div>
        <div className="card-title">{displayText(release.title)}</div>
        <div className="card-sub">{releaseSubtitle(release)}</div>
      </div>
    </button>
  );
}
