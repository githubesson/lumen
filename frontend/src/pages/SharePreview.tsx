import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ExternalLink as ArrowTopRightOnSquareIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ClipboardCopy as ClipboardDocumentIcon,
  Download as DownloadIcon,
  Film as FilmIcon,
  Music as MusicIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
} from "lucide-react";
import { sanitizeFilename } from "@music-library/core/audio-format";
import {
  MAX_SHARE_SNIPPET_DURATION_SEC,
  errorMessage,
  getPublicTrackShare,
  trackSharePreviewVideoUrl,
  type PublicTrackShare,
} from "../api";
import { Button } from "../components/Button";
import CoverArt from "../components/CoverArt";
import ErrorBanner from "../components/ErrorBanner";
import LoadingState from "../components/LoadingState";
import { copyText } from "../lib/clipboard";
import { fmtDurationSec } from "../lib/format";
import { useCopiedFlag } from "../lib/useCopiedFlag";
import { useDismiss } from "../lib/useDismiss";
import { useTransitionMount } from "../lib/useTransitionMount";

export default function SharePreview() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const startSec = Number.parseInt(params.get("t") ?? "0", 10);
  const rawDurationSec = params.get("d");
  const durationSec = rawDurationSec === null
    ? undefined
    : Number(rawDurationSec);
  const sig = params.get("sig") ?? "";

  const [share, setShare] = useState<PublicTrackShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { copied, flash: flashCopied } = useCopiedFlag(1600);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // The route share id starts a new public-resource request lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    setShare(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setMediaDuration(0);

    if (
      !id ||
      !sig ||
      !Number.isFinite(startSec) ||
      startSec < 0 ||
      (durationSec !== undefined && (
        !Number.isInteger(durationSec) ||
        durationSec <= 0 ||
        durationSec > MAX_SHARE_SNIPPET_DURATION_SEC
      ))
    ) {
      setLoading(false);
      setError("Share link unavailable.");
      return;
    }

    getPublicTrackShare(id, startSec, sig, durationSec)
      .then((res) => {
        if (cancelled) return;
        setShare(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err, "Share link unavailable."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [durationSec, id, sig, startSec]);

  const duration = useMemo(() => {
    if (mediaDuration > 0) return mediaDuration;
    return Math.max(1, share?.preview_duration_sec ?? 30);
  }, [mediaDuration, share?.preview_duration_sec]);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
      return;
    }
    if (video.ended || video.currentTime >= duration - 0.1) {
      video.currentTime = 0;
    }
    try {
      await video.play();
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  };

  const seek = useCallback(
    (value: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, Math.min(duration, value * duration));
      setCurrentTime(video.currentTime);
    },
    [duration],
  );

  const copy = async () => {
    if (!share) return;
    // copyText falls back to execCommand when the Clipboard API is missing
    // (e.g. the page is served over plain HTTP on the LAN).
    if (await copyText(share.canonical_url)) flashCopied();
  };

  return (
    <main className="share-preview-page">
      <div className="share-preview-shell">
        <Link to="/" className="share-preview-brand" aria-label="Lumen home">
          <span className="brand-mark">L</span>
          <span>Lumen</span>
        </Link>

        {loading && <LoadingState className="share-preview-status" />}

        {!loading && error && (
          <section className="share-preview-card" aria-label="Shared track">
            <header className="share-preview-header">
              <div className="eyebrow">Shared track</div>
              <h1 className="share-preview-title">Preview unavailable</h1>
            </header>
            <ErrorBanner>{error}</ErrorBanner>
            <footer className="share-preview-footer">
              <Link className="btn btn-primary" to="/">
                <ArrowTopRightOnSquareIcon className="size-4" />
                Open Lumen
              </Link>
            </footer>
          </section>
        )}

        {!loading && share && (
          <section className="share-preview-card" aria-label="Shared track">
            <CoverArt
              className="share-preview-art"
              src={share.cover_url}
              label={share.title}
            />

            <header className="share-preview-header">
              <div className="eyebrow">
                Shared track
                {share.start_sec > 0 && ` · Starts at ${fmtDurationSec(share.start_sec)}`}
              </div>
              <h1 className="share-preview-title">{share.title}</h1>
              <p className="share-preview-meta">
                {share.artist || "Unknown artist"}
                {share.album && ` · ${share.album}`}
              </p>
            </header>

            <div className="share-preview-player">
              <button
                type="button"
                className="play-btn share-preview-play"
                aria-label={isPlaying ? "Pause preview" : "Play preview"}
                onClick={() => void togglePlay()}
              >
                {isPlaying ? (
                  <PauseIcon className="size-4" fill="currentColor" />
                ) : (
                  <PlayIcon className="size-4" fill="currentColor" />
                )}
              </button>
              <div className="share-preview-progress">
                <ShareSeekBar value={progress} onSeek={seek} />
                <div className="share-preview-times">
                  <span>{fmtDurationSec(currentTime)}</span>
                  <span>{fmtDurationSec(duration)}</span>
                </div>
              </div>
            </div>

            <footer className="share-preview-footer">
              <a className="btn btn-primary" href={share.open_url}>
                <ArrowTopRightOnSquareIcon className="size-4" />
                Open Lumen
              </a>
              <Button
                onClick={() => void copy()}
                leadingIcon={copied
                  ? <CheckIcon className="size-4" />
                  : <ClipboardDocumentIcon className="size-4" />}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
              <SnippetDownloadMenu
                share={share}
                videoUrl={trackSharePreviewVideoUrl({
                  trackId: id,
                  startSec,
                  durationSec,
                  sig,
                })}
              />
            </footer>

            <video
              ref={videoRef}
              src={share.preview_url}
              preload="metadata"
              playsInline
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                setMediaDuration(Number.isFinite(d) ? d : 0);
              }}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => {
                setIsPlaying(false);
                setCurrentTime(duration);
              }}
              className="share-preview-media"
            />
          </section>
        )}
      </div>
    </main>
  );
}

/** "Download ▾" — the snippet's audio (M4A) or its generated preview video. */
function SnippetDownloadMenu({
  share,
  videoUrl,
}: {
  share: PublicTrackShare;
  videoUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const { mounted, visible } = useTransitionMount(open, 150);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(rootRef, { onDismiss: close, enabled: open });

  const baseName = sanitizeFilename(
    `${share.artist ? `${share.artist} - ` : ""}${share.title} (clip)`,
  );
  const items = [
    ...(share.audio_url
      ? [{ label: "Audio", hint: "M4A", href: share.audio_url, ext: "m4a", Icon: MusicIcon }]
      : []),
    { label: "Video", hint: "MP4", href: videoUrl, ext: "mp4", Icon: FilmIcon },
  ];

  return (
    <div ref={rootRef} className="share-preview-download">
      <Button
        aria-label="Download snippet"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        leadingIcon={<DownloadIcon className="size-4" />}
        trailingIcon={<ChevronDownIcon className="size-3.5 share-preview-download-chevron" />}
      />
      {mounted && (
        <div
          role="menu"
          className="menu share-preview-download-menu"
          data-closed={!visible || undefined}
        >
          {items.map(({ label, hint, href, ext, Icon }) => (
            <a
              key={ext}
              role="menuitem"
              className="menu-item"
              href={href}
              download={`${baseName}.${ext}`}
              onClick={close}
            >
              <Icon className="size-4" aria-hidden="true" />
              <span style={{ flex: 1 }}>{label}</span>
              <span className="share-preview-download-hint">{hint}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ShareSeekBar({
  value,
  onSeek,
}: {
  value: number;
  onSeek: (value: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const fromClientX = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    return r.width > 0 ? x / r.width : 0;
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (ev: PointerEvent) => onSeek(fromClientX(ev.clientX));
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, fromClientX, onSeek]);

  const pct = Math.max(0, Math.min(1, value)) * 100;
  const pctStr = pct.toFixed(3);

  return (
    <div
      ref={ref}
      className={"bar" + (dragging ? " dragging" : "")}
      role="slider"
      tabIndex={0}
      aria-label="Seek preview"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      onPointerDown={(e) => {
        e.preventDefault();
        setDragging(true);
        onSeek(fromClientX(e.clientX));
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onSeek(Math.max(0, value - 0.05));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onSeek(Math.min(1, value + 0.05));
        } else if (e.key === "Home") {
          e.preventDefault();
          onSeek(0);
        } else if (e.key === "End") {
          e.preventDefault();
          onSeek(1);
        }
      }}
    >
      <div
        className="bar-fill"
        style={{ ["--bar-progress" as string]: (pct / 100).toFixed(5) }}
      />
      <div className="bar-thumb" style={{ left: `${pctStr}%` }} />
    </div>
  );
}
