import {
  releaseVersionLabels,
  type ArtistRelease,
} from "@music-library/core/artist-releases";
import { searchEntityTarget } from "@music-library/core/entity-target";
import SegmentedControl from "../SegmentedControl";
import { Select } from "../Select";

/**
 * Switches between a release's versions: segments while they fit the
 * sleeve's column, a menu past three. Each version's full description is
 * its tooltip.
 */
export default function ReleaseVersionPicker({
  versions,
  current,
  onPick,
}: {
  versions: ArtistRelease[];
  /** The TIDAL id of the version on the page. */
  current: string;
  onPick: (id: string) => void;
}) {
  const labels = releaseVersionLabels(versions);
  const options = versions.map((version, i) => ({
    value: searchEntityTarget(version).id,
    label: labels[i].label,
    title: labels[i].description,
  }));
  if (options.length > 3) {
    return (
      <Select
        className="album-sleeve-versions"
        aria-label="Version"
        value={current}
        onChange={onPick}
        options={options}
      />
    );
  }
  return (
    <SegmentedControl
      className="album-sleeve-versions"
      aria-label="Version"
      value={current}
      onChange={onPick}
      options={options}
    />
  );
}
