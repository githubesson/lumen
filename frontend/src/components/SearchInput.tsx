import {
  forwardRef,
  type CSSProperties,
  type InputHTMLAttributes,
} from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/16/solid";

interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "type"> {
  /** Merged onto the outer `.search` wrapper. */
  className?: string;
  /** Applied to the outer wrapper — size it at the call site. */
  style?: CSSProperties;
  /** When set, Escape clears the query (via this callback) and blurs the input. */
  onClear?: () => void;
}

/**
 * The `.search` icon + input combo. Replaces the verbatim copies in
 * Library / PlaylistDetail / AddTracksDialog / MoveToAlbumDialog. The ref
 * points at the inner input (PlaylistDetail focuses it from a keybinding).
 */
const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput({ className, style, onClear, onKeyDown, ...rest }, ref) {
    return (
      <div className={`search ${className ?? ""}`.trim()} style={style}>
        <MagnifyingGlassIcon className="size-3.5" />
        <input
          ref={ref}
          type="search"
          onKeyDown={
            onClear
              ? (e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onClear();
                    e.currentTarget.blur();
                  }
                  onKeyDown?.(e);
                }
              : onKeyDown
          }
          {...rest}
        />
      </div>
    );
  },
);

export default SearchInput;
