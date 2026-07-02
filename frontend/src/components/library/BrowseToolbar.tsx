import {
  Bars3BottomLeftIcon,
  Squares2X2Icon,
} from "@heroicons/react/16/solid";
import { NativeSelect } from "../Field";
import SearchInput from "../SearchInput";
import SegmentedControl from "../SegmentedControl";

type View = "tracks" | "artists" | "albums";
type SortKey = "recent" | "title" | "artist" | "album" | "duration";

const sortLabels: Record<SortKey, string> = {
  recent: "Recently added",
  title: "Title",
  artist: "Artist",
  album: "Album",
  duration: "Duration",
};

function labelFor(view: View) {
  switch (view) {
    case "tracks":
      return "Tracks";
    case "albums":
      return "Albums";
    case "artists":
      return "Artists";
  }
}

interface BrowseToolbarProps {
  view: View;
  query: string;
  onViewChange: (v: View) => void;
  onQueryChange: (q: string) => void;
  displayMode?: "grid" | "list";
  onDisplayModeChange?: (m: "grid" | "list") => void;
  sort?: SortKey;
  onSortChange?: (s: SortKey) => void;
  selectionControlsHostId?: string;
  className?: string;
}

/**
 * Toolbar for the Library browse page: view tabs, search, sort, display mode,
 * and an optional portal host for track selection controls.
 */
export default function BrowseToolbar({
  view,
  query,
  onViewChange,
  onQueryChange,
  displayMode,
  onDisplayModeChange,
  sort,
  onSortChange,
  selectionControlsHostId,
  className,
}: BrowseToolbarProps) {
  return (
    <div
      className={className}
      style={{
        marginTop: 18,
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <SegmentedControl
        aria-label="View"
        value={view}
        onChange={onViewChange}
        options={(["tracks", "albums", "artists"] as View[]).map((v) => ({
          value: v,
          label: labelFor(v),
        }))}
      />

      <div style={{ flex: 1 }} />

      <SearchInput
        style={{ width: 260 }}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={
          view === "albums"
            ? "Search albums"
            : view === "artists"
              ? "Search artists"
              : "Search local + TIDAL"
        }
      />

      {view === "tracks" && displayMode === "list" && selectionControlsHostId && (
        <div
          id={selectionControlsHostId}
          className="track-selectbar-host"
        />
      )}

      {view === "tracks" && sort != null && onSortChange != null && (
        <NativeSelect
          style={{ width: "auto" }}
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          aria-label="Sort"
        >
          {(Object.keys(sortLabels) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              {sortLabels[k]}
            </option>
          ))}
        </NativeSelect>
      )}

      {view === "tracks" && displayMode != null && onDisplayModeChange != null && (
        <SegmentedControl
          aria-label="Display mode"
          value={displayMode}
          onChange={onDisplayModeChange}
          options={[
            {
              value: "list",
              label: <Bars3BottomLeftIcon className="size-3.5" />,
              ariaLabel: "List",
            },
            {
              value: "grid",
              label: <Squares2X2Icon className="size-3.5" />,
              ariaLabel: "Grid",
            },
          ]}
        />
      )}
    </div>
  );
}
