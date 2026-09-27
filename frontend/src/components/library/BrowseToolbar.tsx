import { SEARCH_TYPE_OPTIONS, type SearchType } from "../../api";
import { List as Bars3BottomLeftIcon, LayoutGrid as Squares2X2Icon } from "lucide-react";
import SearchInput from "../SearchInput";
import { Select, type SelectOption } from "../Select";
import SegmentedControl from "../SegmentedControl";

type View = "tracks" | "artists" | "albums";
type SortKey = "recent" | "title" | "artist" | "album" | "duration";

// What the search box looks for, from the type the search will use.
const SEARCH_NOUN: Record<SearchType, string> = {
  all: "all music",
  track: "tracks",
  album: "albums",
  artist: "artists",
};

const SORT_OPTIONS: SelectOption<SortKey>[] = [
  { value: "recent", label: "Recently added" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "album", label: "Album" },
  { value: "duration", label: "Duration" },
];

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
  searchType: SearchType;
  onSearchTypeChange: (type: SearchType) => void;
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
  searchType,
  onSearchTypeChange,
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
      {query.trim() ? (
        <SegmentedControl
          aria-label="Search type"
          value={searchType}
          onChange={onSearchTypeChange}
          options={SEARCH_TYPE_OPTIONS}
        />
      ) : (
        <SegmentedControl
          aria-label="View"
          value={view}
          onChange={onViewChange}
          options={(["tracks", "albums", "artists"] as View[]).map((v) => ({
            value: v,
            label: labelFor(v),
          }))}
        />
      )}

      <div style={{ flex: 1 }} />

      {/* Select, sort and view mode share one bar, styled like the view
          tabs on the left. Tracks only; a query hides them all. */}
      {!query.trim() && view === "tracks" && (
        <div className="toolbar-group" role="group" aria-label="Track list options">
          {displayMode === "list" && selectionControlsHostId && (
            <>
              <div id={selectionControlsHostId} className="track-selectbar-host" />
              <span className="toolbar-group-sep" aria-hidden="true" />
            </>
          )}
          {sort != null && onSortChange != null && (
            <Select
              variant="toolbar"
              aria-label="Sort"
              value={sort}
              onChange={onSortChange}
              options={SORT_OPTIONS}
            />
          )}
          {displayMode != null && onDisplayModeChange != null && (
            <>
              <span className="toolbar-group-sep" aria-hidden="true" />
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
            </>
          )}
        </div>
      )}

      {/* Last, so the per-view controls come and go to its left and the box
          you're typing in never moves (a query hides them all). */}
      <SearchInput
        style={{ width: 260 }}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        aria-label="Search music"
        placeholder={`Search ${SEARCH_NOUN[searchType]}, local + TIDAL`}
      />
    </div>
  );
}
