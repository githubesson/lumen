import { View } from "react-native";
import type { ImageProps } from "expo-image";
import { SymbolView } from "expo-symbols";
import { CoverArt } from "./cover-art";
import type { DownloadSummary } from "../lib/downloads/download-summary";
import { useTheme } from "../theme/theme";

/** The fan's proportions, as drawn at the Settings card's 48 pt. */
const STEP_RATIO = 14 / 48;
const HEIGHT_RATIO = 54 / 48;
const RADIUS_RATIO = 8 / 48;
const TILT_DEG = 4;

/**
 * Up to four recent download covers fanned out, the newest on top; a
 * download glyph when there are none. The Settings card draws it small and
 * the Downloads screen's header large, so every measure scales with `size`.
 */
export function DownloadCoverFan({
  summary,
  size,
  ringColor,
  priority,
}: {
  summary: DownloadSummary;
  /** Side of one cover. */
  size: number;
  /** The surface behind the fan: a ring in its colour parts each cover from
   *  the one under it. */
  ringColor: string;
  priority?: ImageProps["priority"];
}) {
  const theme = useTheme();
  const step = Math.round(size * STEP_RATIO);
  const height = Math.round(size * HEIGHT_RATIO);
  const radius = Math.round(size * RADIUS_RATIO);
  // Drawn oldest first, so the newest lands on top.
  const covers = [...summary.recent].reverse();
  const count = Math.max(1, covers.length);
  const middle = (count - 1) / 2;
  const shadowAlpha = theme.scheme === "dark" ? 0.35 : 0.16;
  const shadow = `0 ${Math.round(size / 12)}px ${Math.round(size / 5)}px rgba(0, 0, 0, ${shadowAlpha})`;
  const card = {
    position: "absolute",
    top: (height - size) / 2,
    width: size,
    height: size,
    borderRadius: radius,
    borderCurve: "continuous",
  } as const;
  return (
    <View style={{ width: size + (count - 1) * step, height }}>
      {covers.length === 0 ? (
        <View
          style={[
            card,
            {
              left: 0,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.color.bgElev2,
            },
          ]}
        >
          <SymbolView
            name="arrow.down.circle"
            size={Math.round(size * 0.46)}
            tintColor={theme.color.fgMuted}
          />
        </View>
      ) : (
        covers.map((cover, i) => (
          <View
            key={cover.trackId}
            style={[
              card,
              {
                left: i * step,
                zIndex: i,
                transform: [{ rotate: `${(i - middle) * TILT_DEG}deg` }],
                outlineWidth: 1.5,
                outlineColor: ringColor,
                outlineStyle: "solid",
                boxShadow: shadow,
              },
            ]}
          >
            <CoverArt
              track={cover.track ?? { id: cover.trackId }}
              size={size}
              radius={radius}
              transitionMs={0}
              priority={priority}
            />
          </View>
        ))
      )}
    </View>
  );
}
