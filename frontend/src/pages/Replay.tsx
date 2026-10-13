import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Download as ArrowDownTrayIcon,
  Play as PlayIcon,
  ListMusic as QueueListIcon,
  Sparkles as SparklesIcon,
} from "lucide-react";
import {
  api,
  errorMessage,
  type ReplayData,
  type TrackListItem,
} from "../api";
import { readCache, writeCache } from "../lib/resourceCache";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import ReplayBento, { ReplayBentoPlaceholder } from "../components/replay/ReplayBento";
import { Button } from "../components/Button";
import {
  buildPeriodOptions,
  periodKey,
  periodLabel,
  periodTitle,
  type Period,
} from "@music-library/core/replay/period";
import {
  replayCalendar,
  replayDaySpan,
  replayImageFilename,
  replayImageRequest,
  replayPlaylistRequest,
  replayRequest,
  replaySeriesComplete,
  type ReplayRange,
} from "@music-library/core/replay/replay";
import {
  useLocalDay,
  type ResumeSubscriber,
} from "@music-library/core/replay/use-local-day";
import { usePlayerControls } from "../context/Player";
import { usePlaylists } from "../context/Playlists";

// The period model (type, cache key, labels, date ranges, picker options) and
// the listening-time formatter live in `core/src/replay/period.ts`; the mobile
// Replay screen had an identical copy of the date arithmetic. `PeriodOption`
// stays here because this page renders pills rather than the phone's chips.

interface PeriodOption {
  key: string;
  label: string;
  period: Period;
}

// Timers stall while a laptop sleeps, so the day is rechecked when the tab
// is shown again.
const subscribeTabShown: ResumeSubscriber = (onResume) => {
  document.addEventListener("visibilitychange", onResume);
  return () => document.removeEventListener("visibilitychange", onResume);
};

// The days a period covers, in the API's UTC days: "Sep 14 – Oct 13, 2026",
// or its months when only months are known: "Mar 2013 – Oct 2026".
const daySpanFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const monthSpanFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * The period's plays, asked for by day whatever its chart shows: days with
 * plays and the daily average need them, and the chart adds them up into
 * months itself (see `activitySeries`). The server caps how many buckets it
 * sends, so an all-time history longer than that comes back without its
 * newest days; then it is asked for again by month, and the figures count
 * months instead (see `replayCalendar`).
 */
async function fetchReplay(range: ReplayRange, signal: AbortSignal): Promise<ReplayData> {
  const daily = await api.getReplay({ ...range, bucket: "day" }, { signal });
  if (replaySeriesComplete(daily)) return daily;
  return api.getReplay({ ...range, bucket: "month" }, { signal });
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
  const { play } = usePlayerControls();
  const { reload: reloadPlaylists } = usePlaylists();

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
  // The cache key carries the concrete days a rolling period covers (see
  // `replayRequest`). A page left open past midnight recomputes the range
  // (and refetches), so rolling periods don't keep acting on old dates.
  //
  // The answers are daily (see `fetchReplay`), and the key says so: a
  // monthly answer cached under the old key is never read back as daily.
  const today = useLocalDay(subscribeTabShown);
  const request = useMemo(() => {
    const { range, cacheKey } = replayRequest(period);
    return { range, asOf: today, cacheKey: `replay:daily:${cacheKey}` };
  }, [period, today]);
  const range = request.range;
  const chartBucket = range.bucket ?? "month";
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
    fetchReplay(request.range, ac.signal)
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

  // Recomputed with the request, which moves at midnight, so "today" in
  // here stays current.
  const calendar = useMemo(
    () => (data ? replayCalendar(data, request.range) : null),
    [data, request],
  );
  // Known before the data for every period but all time, which starts on its
  // first day with plays.
  const spanLabel = useMemo(() => {
    const span = calendar ?? replayDaySpan(request.range);
    if (!span) return null;
    const format = calendar?.unit === "month" ? monthSpanFormat : daySpanFormat;
    return format.formatRange(span.first, span.last);
  }, [calendar, request]);

  async function onGeneratePlaylist() {
    if (!data || data.summary.total_plays === 0) return;
    setCreatingPlaylist(true);
    setCreateError(null);
    try {
      const playlist = await api.generateReplayPlaylist(
        replayPlaylistRequest(period, range),
      );
      void reloadPlaylists();
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
      const res = await api.getReplayImage(replayImageRequest(period, range));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = replayImageFilename(period);
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
  // Meanwhile the placeholder bento holds the panel's shape, and the results
  // area keeps at least the height it last had, so a period whose panel ran
  // taller (a two-line title on a phone, say) doesn't shrink under the
  // placeholder (dragging the scroll position with it) and grow back. Layout effects, so
  // the observer is gone before the browser lays out the placeholder and
  // can't record it as the new height.
  // The height lives in a ref: resizing the window mustn't re-render the page.
  const hasData = data !== null;
  const resultsRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef(0);
  useLayoutEffect(() => {
    const el = resultsRef.current;
    if (!el || !hasData || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      lastHeightRef.current = el.offsetHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);
  // Set on the element before the browser lays out or paints the commit that
  // swaps in the loading state, so the page never sees the collapsed height.
  useLayoutEffect(() => {
    const el = resultsRef.current;
    if (!el || !showLoading) return;
    el.style.minHeight = `${lastHeightRef.current}px`;
    return () => {
      el.style.minHeight = "";
    };
  }, [showLoading]);
  return (
    <div className="view replay">
      <header className="replay-head">
        <div>
          <div className="detail-kind">Replay</div>
          <h1 className="replay-title">{periodTitle(period)}</h1>
        </div>
        <div className="replay-actions">
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
        </div>
      </header>

      <div className="replay-under">
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
        {spanLabel && <span className="replay-range">{spanLabel}</span>}
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {createError && <ErrorBanner>{createError}</ErrorBanner>}
      {imageError && <ErrorBanner>{imageError}</ErrorBanner>}

      {/* Any in-flight request without this period's own (cached) data shows
          the placeholder bento, not just the first. Rendering retained data
          while a new period loads put the previous window's numbers under
          the new label -- and since the bento below is keyed on the period,
          the key change remounted that stale subtree and replayed its
          entrance, presenting old results as freshly arrived. */}
      <div ref={resultsRef} className="replay-results">
        {showLoading ? (
          <ReplayBentoPlaceholder chartBucket={chartBucket} />
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
        ) : data ? (
          <ReplayBento
            key={periodKey(period)}
            data={data}
            calendar={calendar}
            chartBucket={chartBucket}
            queue={queue}
          />
        ) : null}
      </div>
    </div>
  );
}
