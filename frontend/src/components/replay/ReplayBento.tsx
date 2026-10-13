import { Fragment, useMemo, useState, type CSSProperties, type MouseEventHandler, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  Ellipsis as EllipsisIcon,
  Play as PlayIcon,
} from "lucide-react";
import {
  albumCoverUrl,
  trackCoverUrl,
  type ReplayBucket,
  type ReplayData,
  type ReplayTrack,
  type TrackListItem,
} from "../../api";
import { formatListeningTime } from "@music-library/core/replay/period";
import {
  activityPeak,
  activitySeries,
  genreShares,
  playsPerUnit,
  replayTrackArtists,
  topArtistAction,
  topArtistTracks,
  type ReplayCalendar,
} from "@music-library/core/replay/replay";
import { startListPlayback } from "@music-library/core/player/play-list";
import {
  replayAlbumTarget,
  trackAlbumTarget,
  type EntityTarget,
} from "@music-library/core/entity-target";
import ActivityChart from "../ActivityChart";
import AnimatedNumber from "../AnimatedNumber";
import CoverArt from "../CoverArt";
import { Button } from "../Button";
import MediaCard, { MediaCardPlaceholders } from "../MediaCard";
import ShelfScroller from "../ShelfScroller";
import { TopArtistGlyph, TopArtistName, artistHref } from "../TopArtist";
import TrackList from "../TrackList";
import { FavoriteButton } from "../TrackRowCells";
import { useFavorites } from "../../context/Favorites";
import { usePlayerControls } from "../../context/Player";
import { useContextMenuClickGuard, useTrackContextMenu } from "../../lib/useTrackContextMenu";
import { displayText, fmtDurationMs, pluralize } from "../../lib/format";
import { bentoAreas, type BentoTiles } from "./bentoLayout";

/**
 * Replay as one panel split by hairlines (the stat grid's idiom, scaled up)
 * into tiles sized by importance: the most played track, the period's
 * figures, the rest of the top tracks, the activity chart, genres, and the
 * top artists and albums. Everything named here plays or opens in one click.
 */

/** "45 min" rather than the phone's "45m": the web has room for it. */
const listeningTime = (ms: number) => formatListeningTime(ms, "verbose");

// The API counts UTC days, so their dates are read in UTC.
const shortDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const longDay = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const monthName = new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" });
const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

const CHART_TITLE: Record<ReplayBucket, string> = {
  day: "Every day",
  week: "Every week",
  month: "Every month",
};

/** The day strip has a cell per day up to a month's worth; longer periods get a bar. */
const MAX_STRIP_CELLS = 31;

/** Tracks the panel lists before "Show all": the most played and six more. */
const SHOWN_TRACKS = 8;

/** Tiles reveal one after another, 40ms apart, all within 160ms. */
function tileStyle(area: string, order: number): CSSProperties {
  return { gridArea: area, "--tile-delay": `${Math.min(order, 4) * 40}ms` } as CSSProperties;
}

/** Plays a day: whole numbers from ten up, one decimal below ("1.4"). */
function formatRate(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 10 ? 0 : 1 });
}

function peakLabel(start: string, bucket: ReplayBucket, spansYears: boolean) {
  const date = new Date(start);
  switch (bucket) {
    case "day":
      return { short: shortDay.format(date), long: longDay.format(date) };
    case "week":
      return { short: `Week of ${shortDay.format(date)}`, long: `Week of ${longDay.format(date)}` };
    case "month":
      return {
        short: (spansYears ? monthYear : monthName).format(date),
        long: monthYear.format(date),
      };
  }
}

const albumHref = (target: EntityTarget) =>
  `/library?view=albums&${target.kind === "tidal" ? "tidalAlbum" : "album"}=${encodeURIComponent(target.id)}`;

export default function ReplayBento({
  data,
  calendar,
  chartBucket,
  queue,
}: {
  data: ReplayData;
  /**
   * Plays per day over the period so far -- per month when the server could
   * only send months -- or null when the series can't be counted.
   */
  calendar: ReplayCalendar | null;
  /** How the chart groups the days: by day for a month, by month for a year. */
  chartBucket: ReplayBucket;
  /** The top tracks, which every play here queues. */
  queue: TrackListItem[];
}) {
  const { play } = usePlayerControls();
  const { bind: bindCtx, menu: ctxMenu, close: closeCtx } = useTrackContextMenu();
  const clickGuard = useContextMenuClickGuard(closeCtx);
  const [allTracks, setAllTracks] = useState(false);
  const { summary } = data;
  const [top, ...rest] = data.top_tracks;
  const others = rest.slice(0, SHOWN_TRACKS - 1);
  // "Play top tracks" and "Generate playlist" go past the eight shown, so
  // the rest are one click away too, in the full table.
  const moreTracks = data.top_tracks.length > SHOWN_TRACKS;

  const { bucket: seriesBucket, buckets: series } = useMemo(
    () => (calendar ? activitySeries(calendar, chartBucket) : { bucket: data.bucket, buckets: data.activity }),
    [calendar, chartBucket, data.bucket, data.activity],
  );
  const peak = activityPeak(series);
  const spansYears =
    series.length > 0 &&
    series[0].bucket_start.slice(0, 4) !== series[series.length - 1].bucket_start.slice(0, 4);
  const unit = calendar?.unit === "month" ? "month" : "day";
  const genres = useMemo(() => genreShares(data.top_genres).slice(0, 5), [data.top_genres]);
  // Each top artist's tracks among the top tracks: the first is their
  // picture, and all of them play when they have no page to open.
  const artistTracks = useMemo(
    () => topArtistTracks(data.top_artists, data.top_tracks),
    [data.top_artists, data.top_tracks],
  );
  const perUnit = playsPerUnit(summary.total_plays, calendar);
  const playsColumn = useMemo(
    () => ({
      header: "Plays",
      className: "col-plays",
      render: (t: TrackListItem) => ((t as ReplayTrack).plays ?? 0).toLocaleString(),
    }),
    [],
  );

  const tiles: BentoTiles = {
    feat: !!top,
    list: others.length > 0,
    genre: genres.length > 0,
    art: data.top_artists.length > 0,
    alb: data.top_albums.length > 0,
  };
  const { wide, narrow } = bentoAreas(tiles, { listFull: allTracks });

  return (
    <div
      className="replay-bento replay-enter"
      style={{ "--bento-wide": wide, "--bento-narrow": narrow } as CSSProperties}
    >
      {ctxMenu}
      {top && (
        <FeaturedTrack
          track={top}
          queue={queue}
          onPlay={() => play(top, queue)}
        />
      )}

      <StatTile area="plays" order={1} label="Plays" sub={perUnit != null && `${formatRate(perUnit)} a ${unit} on average`}>
        <AnimatedNumber value={summary.total_plays} />
      </StatTile>
      <StatTile
        area="time"
        order={1}
        label="Listening time"
        sub={summary.total_ms >= 3_600_000 && pluralize(Math.round(summary.total_ms / 60_000), "minute", undefined, { locale: true })}
      >
        <AnimatedNumber format={listeningTime} value={summary.total_ms} />
      </StatTile>
      <StatTile area="tracks" order={2} label="Tracks" sub={`by ${pluralize(summary.unique_artists, "artist", undefined, { locale: true })}`}>
        <AnimatedNumber value={summary.unique_tracks} />
      </StatTile>
      {/* By month only when the server's cap cut a long history short (see
          replaySeriesComplete): it can't say which days had plays then. */}
      <StatTile
        area="days"
        order={2}
        label={unit === "month" ? "Months with plays" : "Days with plays"}
        title={
          calendar
            ? `${calendar.withPlays.toLocaleString()} of ${pluralize(calendar.plays.length, unit, undefined, { locale: true })} had plays`
            : undefined
        }
        sub={calendar && <WithPlays calendar={calendar} />}
      >
        {calendar ? (
          <>
            <AnimatedNumber value={calendar.withPlays} /> <small>of {calendar.plays.length.toLocaleString()}</small>
          </>
        ) : (
          "—"
        )}
      </StatTile>

      {tiles.list && (
        <section className="bento-tile" style={tileStyle("list", 3)} aria-label={allTracks ? "Top tracks" : "Also on repeat"}>
          <div className="bento-head">
            <h2 className="bento-label">{allTracks ? "Top tracks" : "Also on repeat"}</h2>
            {!allTracks && <span className="bento-note" aria-hidden="true">Plays</span>}
          </div>
          {allTracks ? (
            <TrackList tracks={queue} queueSource={queue} extraColumn={playsColumn} />
          ) : (
            <ol className="bento-rows" {...clickGuard}>
              {others.map((t, i) => (
                <RepeatRow
                  key={t.id}
                  track={t}
                  rank={i + 2}
                  max={top.plays}
                  onPlay={() => play(t, queue)}
                  onContextMenu={bindCtx(t, { queue })}
                />
              ))}
            </ol>
          )}
          {moreTracks && (
            <div className="bento-foot">
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={allTracks}
                leadingIcon={allTracks ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
                onClick={() => setAllTracks((all) => !all)}
              >
                {allTracks ? "Show fewer" : `Show all ${data.top_tracks.length}`}
              </Button>
            </div>
          )}
        </section>
      )}

      <section className="bento-tile bento-act" style={tileStyle("act", 3)} aria-label={CHART_TITLE[seriesBucket]}>
        <div className="bento-head">
          <h2 className="bento-label">{CHART_TITLE[seriesBucket]}</h2>
          {peak && (() => {
            const label = peakLabel(peak.bucket_start, seriesBucket, spansYears);
            return (
              <span className="bento-note" title={`Busiest: ${label.long} · ${pluralize(peak.plays, "play", undefined, { locale: true })}`}>
                Peak {label.short} · {pluralize(peak.plays, "play", undefined, { locale: true })}
              </span>
            );
          })()}
        </div>
        <ActivityChart buckets={series} bucket={seriesBucket} />
      </section>

      {tiles.genre && (
        <section className="bento-tile bento-genre" style={tileStyle("genre", 4)} aria-label="Genres">
          <div className="bento-head">
            <h2 className="bento-label">Genres</h2>
          </div>
          <div className="genre-list">
            {genres.map((g) => (
              <div key={g.genre} className="genre-row">
                <div className="genre-label">{displayText(g.genre)}</div>
                <div className="genre-bar-track">
                  <div className="genre-bar-fill" style={{ width: `${g.share}%` }} />
                </div>
                <div className="genre-count">
                  {g.plays.toLocaleString()} · {g.share.toFixed(0)}%
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {tiles.art && (
        <CardsTile area="art" label="Top artists" alone={!tiles.alb}>
          {data.top_artists.map((a, i) => {
            const own = artistTracks.get(a.id) ?? [];
            const action = topArtistAction(a, own);
            return (
              <div key={a.id} className={"card" + (action ? "" : " card-inert")}>
                <CoverArt className="card-art" src={own[0] ? trackCoverUrl(own[0], 384) : null} label={a.name}>
                  <span className="replay-rank">{i + 1}</span>
                  <TopArtistGlyph action={action} className="card-play" iconClassName="size-4" />
                </CoverArt>
                <div>
                  <TopArtistName
                    action={action}
                    artistId={a.id}
                    name={displayText(a.name)}
                    // As on Home: the library has nothing by them, so
                    // their top tracks are what there is to play.
                    onPlay={() => startListPlayback(play, own, false)}
                    className="card-title card-link"
                    plainClassName="card-title"
                  />
                  <div className="card-sub">{pluralize(a.plays, "play", undefined, { locale: true })}</div>
                </div>
              </div>
            );
          })}
        </CardsTile>
      )}
      {tiles.alb && (
        <CardsTile area="alb" label="Top albums" alone={!tiles.art}>
          {data.top_albums.map((a, i) => (
            <MediaCard
              key={a.id}
              to={albumHref(replayAlbumTarget(a))}
              coverUrl={albumCoverUrl(a.id, 384)}
              title={displayText(a.title)}
              subtitle={
                <>
                  {a.artist ? `${displayText(a.artist)} · ` : ""}
                  {pluralize(a.plays, "play", undefined, { locale: true })}
                </>
              }
              rankBadge={<span className="replay-rank">{i + 1}</span>}
            />
          ))}
        </CardsTile>
      )}
    </div>
  );
}

function StatTile({
  area,
  order,
  label,
  title,
  sub,
  children,
}: {
  area: string;
  order: number;
  label: string;
  title?: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bento-tile stat-card" style={tileStyle(area, order)} title={title}>
      <div className="stat-card-label">{label}</div>
      <div>
        <div className="stat-card-value">{children}</div>
        {sub ? <div className="stat-card-sub">{sub}</div> : null}
      </div>
    </div>
  );
}

/**
 * A cell per day (or month), filled when it had plays, up to a month's
 * worth; a bar filled to the share of them for longer periods, where a cell
 * each would be thinner than a pixel.
 */
function WithPlays({ calendar }: { calendar: ReplayCalendar }) {
  const total = calendar.plays.length;
  if (total > MAX_STRIP_CELLS) {
    return (
      <span className="genre-bar-track replay-days-meter" aria-hidden="true">
        <span className="genre-bar-fill" style={{ width: `${(calendar.withPlays / total) * 100}%` }} />
      </span>
    );
  }
  return (
    <span className="replay-days" aria-hidden="true">
      {calendar.plays.map((plays, i) => (
        <span key={i} className={plays > 0 ? undefined : "off"} />
      ))}
    </span>
  );
}

function FeaturedTrack({
  track,
  queue,
  onPlay,
}: {
  track: ReplayTrack;
  queue: TrackListItem[];
  onPlay: () => void;
}) {
  const { isFavorite, toggle } = useFavorites();
  // Its own menu, so "More actions" can say whether it is open.
  const { bind, menu, isOpen: menuOpen } = useTrackContextMenu();
  const onMore = bind(track, { queue });
  const album = trackAlbumTarget(track);
  const title = displayText(track.title);
  // Each linked only when it has a page to open.
  const artists = replayTrackArtists(track);
  // An estimate from the track's length, and labelled as one: the API
  // reports plays per track, not how much of each play was heard.
  const time = track.duration_ms > 0 ? listeningTime(track.plays * track.duration_ms) : null;
  const cover = (
    <CoverArt className="bento-feat-art" src={trackCoverUrl(track, 512)} label={track.title} />
  );

  return (
    <article className="bento-tile bento-feat" style={tileStyle("feat", 0)} onContextMenu={onMore} aria-label="Most played track">
      {menu}
      {album ? (
        // The album link below is the one keyboards and screen readers get.
        <Link to={albumHref(album)} className="bento-feat-cover" tabIndex={-1} aria-hidden="true">
          {cover}
        </Link>
      ) : (
        <div className="bento-feat-cover">{cover}</div>
      )}
      <div className="bento-feat-body">
        <h2 className="bento-label">Most played track</h2>
        <div className="bento-feat-title" title={title}>{title}</div>
        <div className="bento-feat-sub" title={[track.artist || "Unknown artist", track.album_title].filter(Boolean).map((t) => displayText(t)).join(" · ")}>
          {artists.length === 0
            ? "Unknown artist"
            : artists.map((artist, i) => (
                <Fragment key={i}>
                  {i > 0 && ", "}
                  {artist.artistId ? (
                    <Link className="bento-link" to={artistHref(artist.artistId)}>
                      {displayText(artist.name)}
                    </Link>
                  ) : (
                    displayText(artist.name)
                  )}
                </Fragment>
              ))}
          {track.album_title && (
            <>
              {" · "}
              {album ? (
                <Link className="bento-link" to={albumHref(album)}>
                  {displayText(track.album_title)}
                </Link>
              ) : (
                displayText(track.album_title)
              )}
            </>
          )}
        </div>
        <div className="bento-feat-n">
          <b>{pluralize(track.plays, "play", undefined, { locale: true })}</b>
          {time && (
            <span title={`Estimated: ${pluralize(track.plays, "play", undefined, { locale: true })} of a ${fmtDurationMs(track.duration_ms)} track`}>
              {" · about "}
              {time}
            </span>
          )}
        </div>
        <div className="bento-feat-acts">
          <button type="button" className="artist-play" aria-label={`Play ${title}`} onClick={onPlay}>
            <PlayIcon className="size-5" />
          </button>
          <FavoriteButton
            className="iconbtn"
            fav={isFavorite(track.id)}
            onToggle={() => void toggle(track.id)}
          />
          <button
            type="button"
            className="iconbtn"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMore({ preventDefault() {}, clientX: r.left, clientY: r.bottom + 4 });
            }}
          >
            <EllipsisIcon className="size-4" />
          </button>
        </div>
      </div>
    </article>
  );
}

/** One of tracks #2 to #8: plays on click, its plays drawn against #1's. */
function RepeatRow({
  track,
  rank,
  max,
  onPlay,
  onContextMenu,
}: {
  track: ReplayTrack;
  rank: number;
  max: number;
  onPlay: () => void;
  onContextMenu: MouseEventHandler;
}) {
  const title = displayText(track.title);
  return (
    <li className="bento-row" onClick={onPlay} onContextMenu={onContextMenu}>
      <span className="bento-rank">
        <span className="play-cell play-cell-interactive">
          <span className="tabular-nums">{rank}</span>
          <button
            type="button"
            className="idx-play"
            aria-label={`Play ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
          >
            <PlayIcon className="size-3.5" />
          </button>
        </span>
      </span>
      <CoverArt className="bento-row-art" src={trackCoverUrl(track, 64)} label={track.title} />
      <div className="bento-row-text">
        <div className="card-title">{title}</div>
        <div className="card-sub">{displayText(track.artist, "Unknown artist")}</div>
      </div>
      <span className="genre-bar-track" aria-hidden="true">
        <span className="genre-bar-fill" style={{ width: `${max > 0 ? (track.plays / max) * 100 : 0}%` }} />
      </span>
      <span className="bento-row-n">{track.plays.toLocaleString()}</span>
    </li>
  );
}

function CardsTile({
  area,
  label,
  alone,
  children,
}: {
  area: "art" | "alb";
  label: string;
  /** The other cover tile is missing, so this one spans the panel (eight covers to a view, not four). */
  alone: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={"bento-tile bento-cards" + (alone ? " is-alone" : "")}
      style={tileStyle(area, 4)}
      aria-label={label}
    >
      <div className="bento-head">
        <h2 className="bento-label">{label}</h2>
      </div>
      {/* More than fit scroll sideways, with the shelf's edge fades and
          arrows saying so, as on Home. */}
      <div className="bento-minis">
        <ShelfScroller label={label}>{children}</ShelfScroller>
      </div>
    </section>
  );
}

/**
 * The bento's shape while a period loads: the same tiles and labels with
 * bars in place of the figures, so nothing moves when the data lands.
 * `unit` is what the days tile will count, when that's known before the
 * data: all time counts months once its history outgrows the server's cap,
 * so until it answers, its label is a bar too rather than one that changes.
 */
export function ReplayBentoPlaceholder({
  chartBucket,
  unit,
}: {
  chartBucket: ReplayBucket;
  unit: "day" | "month" | null;
}) {
  const { wide, narrow } = bentoAreas({ feat: true, list: true, genre: true, art: true, alb: true });
  const bar = (width: string) => <span className="skeleton-text" style={{ width }} />;
  return (
    <div
      className="replay-bento is-loading"
      style={{ "--bento-wide": wide, "--bento-narrow": narrow } as CSSProperties}
      aria-busy="true"
      aria-label="Loading Replay"
    >
      <div className="bento-tile bento-feat" style={{ gridArea: "feat" }}>
        <div className="bento-feat-cover">
          <div className="cover-art bento-feat-art" />
        </div>
        <div className="bento-feat-body">
          <div className="bento-label">Most played track</div>
          <div className="bento-feat-title">{bar("70%")}</div>
          <div className="bento-feat-sub">{bar("55%")}</div>
          <div className="bento-feat-n">{bar("40%")}</div>
          <div className="bento-feat-acts">
            <span className="artist-play" />
          </div>
        </div>
      </div>
      {([
        ["plays", "Plays"],
        ["time", "Listening time"],
        ["tracks", "Tracks"],
        ["days", unit === "month" ? "Months with plays" : unit === "day" ? "Days with plays" : null],
      ] as const).map(([area, label]) => (
        <div key={area} className="bento-tile stat-card" style={{ gridArea: area }}>
          <div className="stat-card-label">{label ?? bar("60%")}</div>
          <div>
            <div className="stat-card-value">{bar("45%")}</div>
            <div className="stat-card-sub">{bar("65%")}</div>
          </div>
        </div>
      ))}
      <div className="bento-tile" style={{ gridArea: "list" }}>
        <div className="bento-head">
          <div className="bento-label">Also on repeat</div>
        </div>
        <div className="bento-rows">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="bento-row">
              <span />
              <span className="cover-art bento-row-art" />
              <div className="bento-row-text">
                <div className="card-title">{bar(`${60 - i * 4}%`)}</div>
                <div className="card-sub">{bar("35%")}</div>
              </div>
            </div>
          ))}
        </div>
        {/* Most periods have more top tracks than the panel lists. */}
        <div className="bento-foot">
          <span className="btn btn-ghost btn-sm">{bar("72px")}</span>
        </div>
      </div>
      <div className="bento-tile bento-act" style={{ gridArea: "act" }}>
        <div className="bento-head">
          <div className="bento-label">{CHART_TITLE[chartBucket]}</div>
        </div>
        <div className="activity-chart">
          <div className="activity-bars" />
        </div>
      </div>
      <div className="bento-tile bento-genre" style={{ gridArea: "genre" }}>
        <div className="bento-head">
          <div className="bento-label">Genres</div>
        </div>
        <div className="genre-list">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="genre-row">
              <div className="genre-label">{bar("70%")}</div>
              <div className="genre-bar-track" />
              <div className="genre-count">{bar("60%")}</div>
            </div>
          ))}
        </div>
      </div>
      {[
        ["art", "Top artists"],
        ["alb", "Top albums"],
      ].map(([area, label]) => (
        <div key={area} className="bento-tile bento-cards" style={{ gridArea: area }}>
          <div className="bento-head">
            <div className="bento-label">{label}</div>
          </div>
          <div className="bento-minis">
            <div className="shelf-scroller">
              <div className="shelf">
                <MediaCardPlaceholders count={4} />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
