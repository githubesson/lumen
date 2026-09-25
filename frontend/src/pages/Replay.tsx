import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Download as ArrowDownTrayIcon,
  Play as PlayIcon,
  ListMusic as QueueListIcon,
  Sparkles as SparklesIcon,
} from "lucide-react";
import {
  albumCoverUrl,
  api,
  errorMessage,
  trackCoverUrl,
  type ReplayData,
  type TrackListItem,
} from "../api";
import TrackList from "../components/TrackList";
import StatCard from "../components/StatCard";
import AnimatedNumber from "../components/AnimatedNumber";
import { readCache, writeCache } from "../lib/resourceCache";
import ActivityChart from "../components/ActivityChart";
import ErrorBanner from "../components/ErrorBanner";
import LoadingState from "../components/LoadingState";
import EmptyState from "../components/EmptyState";
import MediaCard from "../components/MediaCard";
import ListPageHeader from "../components/ListPageHeader";
import Section from "../components/Section";
import { Button } from "../components/Button";
import {
  buildPeriodOptions,
  formatListeningTime as formatListeningTimeCore,
  periodKey,
  periodLabel,
  periodRange,
  periodTitle,
  type Period,
} from "@music-library/core/replay/period";
import { displayText, pluralize } from "../lib/format";
import { usePlayer } from "../context/Player";

/** The web has room for the fuller wording ("45 min", not the phone's "45m"). */
function formatListeningTime(ms: number): string {
  return formatListeningTimeCore(ms, "verbose");
}

// The period model (type, cache key, labels, date ranges, picker options) and
// the listening-time formatter live in `core/src/replay/period.ts`; the mobile
// Replay screen had an identical copy of the date arithmetic. `PeriodOption`
// stays here because this page renders pills rather than the phone's chips.

interface PeriodOption {
  key: string;
  label: string;
  period: Period;
}

function buildOptions(availableYears: number[]): PeriodOption[] {
  return buildPeriodOptions(availableYears).map((period) => ({
    key: periodKey(period),
    label: periodLabel(period),
    period,
  }));
}

export default function Replay() {
  const navigate = useNavigate();
  const { play } = usePlayer();

  const [period, setPeriod] = useState<Period>({ kind: "this-year" });
  // The response is stored with the period it answers, and read back only when
  // the two still match. A period switch therefore drops to `data === null` on
  // the very first render -- before the fetch effect has even run -- so the
  // previous window's results can never be rendered, animated, or acted on
  // under the new period's title.
  const [loaded, setLoaded] = useState<{ key: string; data: ReplayData } | null>(null);
  // Sticky: the year pills are navigation, not results, and must survive the
  // gap where `data` is null or the selector would collapse mid-load.
  // Remembered across visits so the pills are all there on arrival.
  const [years, setYears] = useState<number[]>(() => readCache<number[]>("replay:years") ?? []);
  const [error, setError] = useState<string | null>(null);
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [downloadingImage, setDownloadingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Memoize the request range on the selected period so the fetch effect can
  // depend on a stable value. `period` only changes identity when the user
  // picks a new pill, so depending on it directly is both correct and
  // exhaustive-deps clean (the old code keyed on a fresh periodKey string).
  //
  // Rolling periods ("this month") keep their key across a boundary, so the
  // cache also keys on the concrete days they cover: last month's numbers
  // never answer for this month. Day granularity lets "last 30 days" still
  // hit within a day. A page left open past midnight recomputes the range
  // (and refetches), so rolling periods don't keep acting on old dates.
  const today = useLocalDay();
  const request = useMemo(() => {
    const range = periodRange(period);
    const key = periodKey(period);
    const day = (iso?: string) => iso?.slice(0, 10) ?? "";
    return {
      key,
      range,
      asOf: today,
      cacheKey: `replay:${key}:${day(range.from)}:${day(range.to)}`,
    };
  }, [period, today]);
  const range = request.range;
  // A period seen before this session answers from the cache while it
  // refreshes -- still that period's own numbers, never another's.
  const data =
    loaded?.key === request.cacheKey
      ? loaded.data
      : (readCache<ReplayData>(request.cacheKey) ?? null);

  useEffect(() => {
    const ac = new AbortController();
    // Changing the replay period starts a new API request lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    api
      .getReplay(request.range, { signal: ac.signal })
      .then((d) => {
        // Aborting after the response headers arrive does not reject this
        // promise: the transport drops the caller's abort listener as soon as
        // `fetch` resolves, before it parses the body. A superseded request
        // landing after the current one would otherwise replace its results
        // with the previous period's, which the keyed derivation rejects --
        // leaving the loading state up for good.
        if (ac.signal.aborted) return;
        setLoaded({ key: request.cacheKey, data: d });
        setYears(d.available_years ?? []);
        writeCache(request.cacheKey, d);
        writeCache("replay:years", d.available_years ?? []);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setError(errorMessage(err, "Failed to load Replay."));
      });
    return () => ac.abort();
  }, [request]);

  const options = useMemo(() => buildOptions(years), [years]);

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
      a.download = `replay-${periodKey(period).replace(/[^a-z0-9-]/gi, "-")}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setImageError(errorMessage(err, "Failed to create the share image."));
    } finally {
      setDownloadingImage(false);
    }
  }

  const summary = data?.summary;

  // No data for this period and no error means its request is in flight,
  // including the render between picking a period and the effect starting it.
  const showLoading = !data && !error;
  // Meanwhile, hold the results area at the height it last had, so the page
  // doesn't collapse to a loading line (dragging the scroll position with it)
  // and grow back. A layout effect, so the observer is gone before the
  // browser lays out the emptied area and can't record it as the new height.
  const hasData = data !== null;
  const resultsRef = useRef<HTMLDivElement>(null);
  const [reservedHeight, setReservedHeight] = useState(0);
  useLayoutEffect(() => {
    const el = resultsRef.current;
    if (!el || !hasData || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setReservedHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);
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
                style={{ color: "var(--muted-foreground)" }}
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
          const active = periodKey(opt.period) === periodKey(period);
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

      {/* Any in-flight request without this period's own (cached) data shows
          the loading state, not just the first. Rendering retained data while
          a new period loads put the previous window's numbers under the new
          label -- and since the block below is keyed on the period, the key
          change remounted that stale subtree and replayed its entrance,
          presenting old results as freshly arrived. */}
      <div ref={resultsRef} style={{ minHeight: showLoading ? reservedHeight : undefined }}>
        {showLoading ? (
          <LoadingState />
        ) : summary && summary.total_plays === 0 ? (
          <EmptyState
            icon={<SparklesIcon className="size-10" />}
            title="No plays in this window yet."
            hint={
              <>
                <Link to="/library" style={{ color: "var(--foreground)", textDecoration: "underline", textUnderlineOffset: 4 }}>
                  Listen to some music
                </Link>{" "}
                and check back here.
              </>
            }
          />
        ) : data && summary ? (
          <div
            key={periodKey(period)}
            className="replay-enter"
            style={{ display: "grid", gap: 18, minWidth: 0 }}
          >
            <section className="stat-grid">
              <StatCard
                label="Total plays"
                value={
                  <AnimatedNumber value={summary.total_plays} />
                }
              />
              <StatCard
                label="Listening time"
                value={
                  <AnimatedNumber
                    format={formatListeningTime}
                    value={summary.total_ms}
                  />
                }
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
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The local date, updated when it changes: a timer set for midnight, plus a
 * check on returning to the tab, since timers stall while a laptop sleeps.
 */
function useLocalDay() {
  const [day, setDay] = useState(() => new Date().toDateString());
  useEffect(() => {
    let timer = 0;
    const check = () => setDay(new Date().toDateString());
    const arm = () => {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(() => {
        check();
        arm();
      }, midnight.getTime() - now.getTime() + 1000);
    };
    arm();
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return day;
}
