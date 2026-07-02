import clsx from "clsx";
import { HeartIcon, PlayIcon } from "@heroicons/react/16/solid";
import { usePopKey } from "../lib/useTransitionMount";
import TrackCheckbox from "./TrackCheckbox";

/**
 * Shared cells and controls for track tables (TrackList, the playlist
 * tracks table) and the mini player. Extracted from the verbatim copies in
 * TrackList's TrackRow and PlaylistDetail's PlaylistRow.
 */

/** The three animated "now playing" bars. */
export function PlayingBars({ className }: { className?: string }) {
  return (
    <span className={clsx("playing-bars", className)} aria-label="now playing">
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * `.col-idx` cell: playing bars while the row's track is playing, otherwise
 * the zero-padded row number. Pass `onPlay` to also render the hover play
 * button that replaces the number (playlist table behavior).
 */
export function TrackIndexCell({
  index,
  isPlaying,
  onPlay,
  playLabel,
}: {
  index: number;
  isPlaying: boolean;
  onPlay?: () => void;
  playLabel?: string;
}) {
  return (
    <td className="col-idx">
      <span className="play-cell">
        {isPlaying ? (
          <PlayingBars className="idx-bars" />
        ) : (
          <>
            <span className="idx-num">{String(index + 1).padStart(2, "0")}</span>
            {onPlay && (
              <button
                type="button"
                className="idx-play"
                onClick={(e) => {
                  e.stopPropagation();
                  onPlay();
                }}
                aria-label={playLabel ?? "Play"}
                style={{
                  background: "transparent",
                  border: 0,
                  color: "var(--fg)",
                  cursor: "pointer",
                  display: "inline-grid",
                  placeItems: "center",
                }}
              >
                <PlayIcon className="size-3.5" />
              </button>
            )}
          </>
        )}
      </span>
    </td>
  );
}

/**
 * Heart toggle with the pop animation. Used in row action clusters and the
 * mini player's utility strip — pass `className` for the button chrome
 * (e.g. `t-btn`) and `iconClassName` for icon tweaks (e.g. `shrink-0`).
 */
export function FavoriteButton({
  fav,
  onToggle,
  disabled,
  className,
  iconClassName,
}: {
  fav: boolean;
  onToggle: () => void;
  disabled?: boolean;
  className?: string;
  iconClassName?: string;
}) {
  const popKey = usePopKey(fav);
  return (
    <button
      type="button"
      className={clsx(className, fav && "active") || undefined}
      aria-label={fav ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={fav}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <HeartIcon
        key={popKey}
        className={clsx(
          "size-3.5",
          iconClassName,
          popKey > 0 && "motion-safe:animate-heart-pop",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

/** `.col-select` header cell with the select-all / indeterminate checkbox. */
export function SelectAllHeaderCell({
  allSelected,
  someSelected,
  onToggle,
}: {
  allSelected: boolean;
  someSelected: boolean;
  onToggle: () => void;
}) {
  return (
    <th className="col-select">
      <TrackCheckbox
        checked={allSelected}
        indeterminate={someSelected && !allSelected}
        ariaLabel={allSelected ? "Deselect all tracks" : "Select all tracks"}
        onChange={onToggle}
      />
    </th>
  );
}

/** `.col-select` body cell; `onToggle` receives whether shift was held (range select). */
export function TrackSelectCell({
  selected,
  label,
  onToggle,
}: {
  selected: boolean;
  label: string;
  onToggle: (range: boolean) => void;
}) {
  return (
    <td className="col-select">
      <TrackCheckbox
        checked={selected}
        ariaLabel={`Select ${label}`}
        onChange={(e) => onToggle(e.shiftKey)}
      />
    </td>
  );
}
