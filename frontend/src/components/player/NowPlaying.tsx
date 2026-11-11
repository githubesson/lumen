import { useEffect, useState } from "react";
import { useInRouterContext } from "react-router-dom";
import type { TrackListItem } from "@music-library/core";
import { trackAlbumHref } from "../../lib/nowPlayingLinks";
import { ArtistLinks, PageLink } from "../EntityLinks";
import { trackCoverUrl } from "../../api";
import { displayText } from "../../lib/format";
import CoverArt from "../CoverArt";
import PlaybackErrorPopover from "./PlaybackErrorPopover";
import { usePopoverOpen, type MiniPanelToggle } from "./useMiniPlayerMode";

export default function NowPlaying({
  track,
  title,
  artist,
  error,
  errorPanel,
  onContextMenu,
  links = true,
}: {
  track: TrackListItem | null;
  title: string;
  artist: string;
  /**
   * Why the track stopped playing; shown in place of the artist. Clicking it
   * shows what happened.
   */
  error?: string | null;
  /** In the mini player the details open in its panel instead of a popover. */
  errorPanel?: MiniPanelToggle;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  /** Title, artists and album open their pages (off in the mini player). */
  links?: boolean;
}) {
  const linked = useInRouterContext() && links && !!track && !error;
  const coverSrc = track ? trackCoverUrl(track) : null;
  // Held in state, as in DevicePickerButton: the popover reads them during
  // render.
  const [block, setBlock] = useState<HTMLDivElement | null>(null);
  const [errorButton, setErrorButton] = useState<HTMLButtonElement | null>(null);
  const [detailsOpen, setDetailsOpen] = usePopoverOpen(!!errorPanel);
  // The details go with the failure: playing again, or another track, shuts
  // them, so the next failure doesn't open them by itself.
  if (!error && detailsOpen) setDetailsOpen(false);
  const panelShowsGoneError = !error && !!errorPanel?.open;
  const closePanel = errorPanel?.close;
  useEffect(() => {
    if (panelShowsGoneError) closePanel?.();
  }, [panelShowsGoneError, closePanel]);
  const open = errorPanel ? errorPanel.open : detailsOpen;

  return (
    <>
      <div className="np" ref={setBlock} onContextMenu={onContextMenu}>
        <CoverArt
          className="np-art"
          src={coverSrc}
          label={displayText(track?.album_title || track?.title, "·")}
          forcePlaceholder={!track}
        />
        <div className="np-text">
          <div className="np-title" title={title}>
            {linked ? (
              <PageLink label={`Go to the album of ${title}`} href={() => trackAlbumHref(track)}>
                {title}
              </PageLink>
            ) : (
              title
            )}
          </div>
          <div
            className={"np-artist" + (error ? " np-error" : "")}
            title={error ? undefined : artist}
          >
            {/* Always rendered, so screen readers announce a failure as it
                appears rather than only when they reach the line. */}
            <span role="status">
              {error && (
                <button
                  ref={setErrorButton}
                  type="button"
                  className="np-error-btn"
                  title={error}
                  // The mini player's panel is a region, not a dialog.
                  aria-haspopup={errorPanel ? undefined : "dialog"}
                  aria-expanded={open}
                  aria-controls={errorPanel?.controls}
                  onClick={
                    errorPanel
                      ? errorPanel.onToggle
                      : (event) => {
                          // Closing: focus may be inside the popover, and not
                          // every browser moves it to a clicked button.
                          if (detailsOpen) event.currentTarget.focus();
                          setDetailsOpen((v) => !v);
                        }
                  }
                >
                  {error}
                </button>
              )}
            </span>
            {!error && !linked && artist}
            {linked && (
              <>
                <ArtistLinks track={track} fallback="—" />
                {track.album_title && (
                  <>
                    {" · "}
                    <PageLink label={`Go to ${track.album_title}`} href={() => trackAlbumHref(track)}>
                      {displayText(track.album_title)}
                    </PageLink>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {/* Outside the block, so its context menu doesn't reach the popover. */}
      <PlaybackErrorPopover
        open={detailsOpen}
        anchor={block}
        toggle={errorButton}
        onClose={() => setDetailsOpen(false)}
      />
    </>
  );
}

