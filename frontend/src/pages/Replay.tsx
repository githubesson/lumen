import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowDownTrayIcon,
  PlayIcon,
  QueueListIcon,
  SparklesIcon,
} from "@heroicons/react/16/solid";
import {
  albumCoverUrl,
  api,
  errorMessage,
  trackCoverUrl,
  type ReplayData,
  type ReplayBucket,
  type TrackListItem,
} from "../api";
import TrackList from "../components/TrackList";
import StatCard from "../components/StatCard";
import AnimatedNumber from "../components/AnimatedNumber";
import ActivityChart from "../components/ActivityChart";
import ErrorBanner from "../components/ErrorBanner";
import LoadingState from "../components/LoadingState";
import EmptyState from "../components/EmptyState";
import MediaCard from "../components/MediaCard";
import ListPageHeader from "../components/ListPageHeader";
import Section from "../components/Section";
import { Button } from "../components/Button";
import { displayText, pluralize } from "../lib/format";
import { usePlayer } from "../context/Player";

type PeriodKey =
  | { kind: "all" }
  | { kind: "this-year" }
  | { kind: "year"; year: number }
  | { kind: "this-month" }
  | { kind: "last-30" };

interface PeriodOption {
  key: string;
  label: string;
  period: PeriodKey;
}

function periodToKey(p: PeriodKey): string {
  switch (p.kind) {
    case "all":
      return "all";
    case "this-year":
      return "this-year";
    case "year":
      return `year:${p.year}`;
    case "this-month":
      return "this-month";
    case "last-30":
      return "last-30";
  }
}

function periodTitle(p: PeriodKey): string {
  switch (p.kind) {
    case "all":
      return "All time";
    case "this-year":
      return `This year (${new Date().getFullYear()})`;
    case "year":
      return String(p.year);
    case "this-month":
      return new Date().toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    case "last-30":
      return "Last 30 days";
  }
}

function periodRange(p: PeriodKey): {
  from?: string;
  to?: string;
  bucket?: ReplayBucket;
} {
  const now = new Date();
  switch (p.kind) {
    case "all":
      return { bucket: "month" };
    case "this-year": {
      const from = new Date(Date.UTC(now.getFullYear(), 0, 1));
      const to = new Date(Date.UTC(now.getFullYear() + 1, 0, 1));
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        bucket: "month",
      };
    }
    case "year": {
      const from = new Date(Date.UTC(p.year, 0, 1));
      const to = new Date(Date.UTC(p.year + 1, 0, 1));
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        bucket: "month",
      };
    }
    case "this-month": {
      const from = new Date(
        Date.UTC(now.getFullYear(), now.getMonth(), 1),
      );
      const to = new Date(
        Date.UTC(now.getFullYear(), now.getMonth() + 1, 1),
      );
      return { from: from.toISOString(), to: to.toISOString(), bucket: "day" };
    }
    case "last-30": {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from: from.toISOString(), to: to.toISOString(), bucket: "day" };
    }
  }
}

function buildOptions(availableYears: number[]): PeriodOption[] {
  const currentYear = new Date().getFullYear();
  const opts: PeriodOption[] = [
    { key: "all", label: "All time", period: { kind: "all" } },
    {
      key: "this-year",
      label: "This year",
      period: { kind: "this-year" },
    },
  ];
  for (const y of availableYears) {
    if (y === currentYear) continue;
    opts.push({
      key: `year:${y}`,
      label: String(y),
      period: { kind: "year", year: y },
    });
  }
  opts.push(
    { key: "this-month", label: "This month", period: { kind: "this-month" } },
    { key: "last-30", label: "Last 30 days", period: { kind: "last-30" } },
  );
  return opts;
}

function formatListeningTime(ms: number): string {
  if (ms <= 0) return "0 min";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes - days * 60 * 24 - hours * 60;
  if (days >= 1) {
    return hours > 0
      ? `${days}d ${hours}h`
      : `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (hours >= 1) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes} min`;
}

export default function Replay() {
  const navigate = useNavigate();
  const { play } = usePlayer();

  const [period, setPeriod] = useState<PeriodKey>({ kind: "this-year" });
  const [data, setData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [downloadingImage, setDownloadingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Memoize the request range on the selected period so the fetch effect can
  // depend on a stable value. `period` only changes identity when the user
  // picks a new pill, so depending on it directly is both correct and
  // exhaustive-deps clean (the old code keyed on a fresh periodToKey string).
  const range = useMemo(() => periodRange(period), [period]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    api
      .getReplay(range, { signal: ac.signal })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setError(errorMessage(err, "Failed to load Replay."));
        setLoading(false);
      });
    return () => ac.abort();
  }, [range]);

  const options = useMemo(
    () => buildOptions(data?.available_years ?? []),
    [data?.available_years],
  );

  const queue = useMemo<TrackListItem[]>(
    () => (data?.top_tracks ?? []) as TrackListItem[],
    [data?.top_tracks],
  );

  const playsById = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of data?.top_tracks ?? []) m.set(t.id, t.plays);
    return m;
  }, [data?.top_tracks]);

  const collageTracks = useMemo(() => queue.slice(0, 4), [queue]);

  async function onGeneratePlaylist() {
    if (!data || data.summary.total_plays === 0) return;
    setCreatingPlaylist(true);
    setCreateError(null);
    try {
      const name = `Replay · ${periodTitle(period)}`;
      const playlist = await api.generateReplayPlaylist({
        from: range.from,
        to: range.to,
        name,
        limit: 50,
      });
      navigate(`/playlists/${playlist.id}`);
    } catch (err) {
      setCreateError(errorMessage(err, "Failed to create playlist."));
    } finally {
      setCreatingPlaylist(false);
    }
  }

  async function onDownloadImage() {
    if (!data || data.summary.total_plays === 0) return;
    setDownloadingImage(true);
    setImageError(null);
    try {
      const res = await api.getReplayImage({
        from: range.from,
        to: range.to,
        title: periodTitle(period),
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `replay-${periodToKey(period).replace(/[^a-z0-9-]/gi, "-")}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setImageError(errorMessage(err, "Failed to create the share image."));
    } finally {
      setDownloadingImage(false);
    }
  }

  const summary = data?.summary;
  const totalGenrePlays = useMemo(
    () => (data?.top_genres ?? []).reduce((acc, g) => acc + g.plays, 0),
    [data?.top_genres],
  );

  const extraColumn = useMemo(
    () => ({
      header: "Plays",
      className: "col-plays",
      render: (t: TrackListItem) => (playsById.get(t.id) ?? 0).toLocaleString(),
    }),
    [playsById],
  );

  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <ListPageHeader
        className="replay-hero"
        kind="Replay"
        title={periodTitle(period)}
        art={
          <div className="detail-art replay-hero-art">
            {collageTracks.length >= 4 ? (
              <div className="replay-collage">
                {collageTracks.map((t) => (
                  <div
                    key={t.id}
                    className="replay-collage-cell"
                    style={{ backgroundImage: `url(${trackCoverUrl(t)})` }}
                    aria-hidden="true"
                  />
                ))}
              </div>
            ) : collageTracks.length > 0 ? (
              <div
                className="replay-collage-cell"
                style={{
                  width: "100%",
                  height: "100%",
                  backgroundImage: `url(${trackCoverUrl(collageTracks[0])})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
                aria-hidden="true"
              />
            ) : (
              <SparklesIcon
                className="size-12"
                style={{ color: "var(--accent-fg)" }}
              />
            )}
          </div>
        }
        meta={
          <>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {summary
                ? `${summary.total_plays.toLocaleString()} ${summary.total_plays === 1 ? "play" : "plays"}`
                : "—"}
            </span>
            <span className="dot" />
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {summary ? formatListeningTime(summary.total_ms) : "—"}
            </span>
          </>
        }
        actions={
          <>
            <Button
              variant="primary"
              disabled={!data || queue.length === 0}
              onClick={() => queue.length > 0 && play(queue[0], queue)}
              leadingIcon={<PlayIcon className="size-4" />}
            >
              Play top tracks
            </Button>
            <Button
              disabled={!data || queue.length === 0 || creatingPlaylist}
              onClick={onGeneratePlaylist}
              leadingIcon={<QueueListIcon className="size-4" />}
            >
              {creatingPlaylist ? "Creating…" : "Generate playlist"}
            </Button>
            <Button
              disabled={!data || queue.length === 0 || downloadingImage}
              onClick={onDownloadImage}
              leadingIcon={<ArrowDownTrayIcon className="size-4" />}
            >
              {downloadingImage ? "Rendering…" : "Share image"}
            </Button>
          </>
        }
      />

      <div className="period-pills" role="tablist" aria-label="Replay period">
        {options.map((opt) => {
          const active = periodToKey(opt.period) === periodToKey(period);
          return (
            <button
              key={opt.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={"period-pill" + (active ? " active" : "")}
              onClick={() => setPeriod(opt.period)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {createError && <ErrorBanner>{createError}</ErrorBanner>}
      {imageError && <ErrorBanner>{imageError}</ErrorBanner>}

      {loading && !data ? (
        <LoadingState />
      ) : summary && summary.total_plays === 0 ? (
        <EmptyState
          icon={<SparklesIcon className="size-10" />}
          title="No plays in this window yet."
          hint={
            <>
              <Link to="/library" style={{ color: "var(--accent-fg)" }}>
                Listen to some music
              </Link>{" "}
              and check back here.
            </>
          }
        />
      ) : data && summary ? (
        <>
          <section className="stat-grid">
            <StatCard
              label="Total plays"
              value={
                <AnimatedNumber value={summary.total_plays} />
              }
            />
            <StatCard
              label="Listening time"
              value={formatListeningTime(summary.total_ms)}
              title={
                summary.total_ms >= 60_000
                  ? `${Math.round(summary.total_ms / 60_000).toLocaleString()} minutes total`
                  : undefined
              }
            />
            <StatCard
              label="Unique tracks"
              value={<AnimatedNumber value={summary.unique_tracks} />}
            />
            <StatCard
              label="Unique artists"
              value={<AnimatedNumber value={summary.unique_artists} />}
            />
          </section>

          {data.top_tracks.length > 0 && (
            <Section sub="On repeat" title="Top tracks">
              <TrackList
                tracks={queue}
                queueSource={queue}
                extraColumn={extraColumn}
              />
            </Section>
          )}

          {data.top_artists.length > 0 && (
            <Section sub="On the marquee" title="Top artists">
              <div className="shelf replay-shelf">
                {data.top_artists.map((a, i) => (
                  <MediaCard
                    key={a.id}
                    swatchSeed={a.id}
                    title={displayText(a.name)}
                    subtitle={pluralize(a.plays, "play")}
                    rankBadge={<span className="replay-rank">{i + 1}</span>}
                  />
                ))}
              </div>
            </Section>
          )}

          {data.top_albums.length > 0 && (
            <Section sub="Played front to back" title="Top albums">
              <div className="shelf replay-shelf">
                {data.top_albums.map((a, i) => (
                  <MediaCard
                    key={a.id}
                    coverUrl={albumCoverUrl(a.id)}
                    title={displayText(a.title)}
                    subtitle={
                      <>
                        {a.artist ? `${displayText(a.artist)} · ` : ""}
                        {pluralize(a.plays, "play")}
                      </>
                    }
                    rankBadge={<span className="replay-rank">{i + 1}</span>}
                  />
                ))}
              </div>
            </Section>
          )}

          {data.activity.length > 0 && (
            <Section sub="When you listened" title="Listening activity">
              <ActivityChart
                buckets={data.activity}
                bucket={data.bucket}
              />
            </Section>
          )}

          {data.top_genres.length > 0 && (
            <Section sub="What filled the room" title="Top genres">
              <div className="genre-list">
                {data.top_genres.map((g) => {
                  const pct =
                    totalGenrePlays > 0
                      ? (g.plays / totalGenrePlays) * 100
                      : 0;
                  return (
                    <div key={g.genre} className="genre-row">
                      <div className="genre-label">{displayText(g.genre)}</div>
                      <div className="genre-bar-track">
                        <div
                          className="genre-bar-fill"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="genre-count mono">
                        {g.plays} · {pct.toFixed(0)}%
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}
        </>
      ) : null}
    </div>
  );
}

