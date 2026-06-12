import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowTopRightOnSquareIcon,
  ClipboardDocumentIcon,
  PauseIcon,
  PlayIcon,
} from "@heroicons/react/16/solid";
import {
  errorMessage,
  getPublicTrackShare,
  type PublicTrackShare,
} from "../api";
import { Button } from "../components/Button";
import CoverArt from "../components/CoverArt";
import ErrorBanner from "../components/ErrorBanner";
import LoadingState from "../components/LoadingState";
import { useAccentFromCover } from "../lib/accent";
import { fmtDurationSec } from "../lib/format";

export default function SharePreview() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const startSec = Number.parseInt(params.get("t") ?? "0", 10);
  const sig = params.get("sig") ?? "";

  const [share, setShare] = useState<PublicTrackShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);

  useAccentFromCover(share?.cover_url);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setShare(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setMediaDuration(0);

    if (!id || !sig || !Number.isFinite(startSec) || startSec < 0) {
      setLoading(false);
      setError("Share link unavailable.");
      return;
    }

    getPublicTrackShare(id, startSec, sig)
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
  }, [id, sig, startSec]);

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
    try {
      await navigator.clipboard.writeText(share.canonical_url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
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
          <section className="share-preview-panel" aria-label="Shared track">
            <div className="share-preview-copy">
              <div className="share-preview-kicker mono">Shared track</div>
              <h1>Preview unavailable</h1>
              <ErrorBanner>{error}</ErrorBanner>
              <Link className="btn" to="/">
                Open Lumen
              </Link>
            </div>
          </section>
        )}

        {!loading && share && (
          <section className="share-preview-panel" aria-label="Shared track">
            <div className="share-preview-art-wrap">
              <CoverArt
                className="share-preview-art"
                src={share.cover_url}
                seed={share.album_id || share.track_id}
                label={share.title}
              />
            </div>

            <div className="share-preview-copy">
              <div className="share-preview-kicker mono">Shared track</div>
              <h1>{share.title}</h1>
              <div className="share-preview-meta">
                <span>{share.artist || "Unknown artist"}</span>
                {share.album && (
                  <>
                    <span className="dot" />
                    <span>{share.album}</span>
                  </>
                )}
              </div>

              <div className="share-preview-player">
                <button
                  type="button"
                  className="play-btn share-preview-play"
                  aria-label={isPlaying ? "Pause preview" : "Play preview"}
                  onClick={() => void togglePlay()}
                >
                  {isPlaying ? (
                    <PauseIcon className="size-5" />
                  ) : (
                    <PlayIcon className="size-5" />
                  )}
                </button>
                <div className="share-preview-progress">
                  <div className="progress">
                    <span className="progress-time">{fmtDurationSec(currentTime)}</span>
                    <ShareSeekBar value={progress} onSeek={seek} />
                    <span className="progress-time">{fmtDurationSec(duration)}</span>
                  </div>
                  <div className="share-preview-window mono">
                    Starts at {fmtDurationSec(share.start_sec)}
                  </div>
                </div>
              </div>

              <div className="share-preview-actions">
                <a className="btn btn-primary" href={share.open_url}>
                  <ArrowTopRightOnSquareIcon className="size-4" />
                  Open Lumen
                </a>
                <Button
                  onClick={() => void copy()}
                  leadingIcon={<ClipboardDocumentIcon className="size-4" />}
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
            </div>

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
      <div className="bar-fill" style={{ width: `${pctStr}%` }} />
      <div className="bar-thumb" style={{ left: `${pctStr}%` }} />
    </div>
  );
}
