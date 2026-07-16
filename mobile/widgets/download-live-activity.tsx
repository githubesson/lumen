import {
  HStack,
  Image,
  ProgressView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  containerBackground,
  font,
  foregroundStyle,
  frame,
  labelsHidden,
  lineLimit,
  monospacedDigit,
  padding,
  progressViewStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity } from "expo-widgets";

/** Everything dynamic lives in props (there are no separate attributes), so a
 *  second playlist can merge into the running activity — title included. */
export type DownloadActivityProps = {
  /** Playlist name, or "N playlists" when concurrent downloads merged. */
  title: string;
  totalTracks: number;
  completedTracks: number;
  failedTracks: number;
  currentTrackTitle: string;
  /** Overall fraction across the session, 0..1. */
  progress: number;
  phase: "downloading" | "done" | "partial";
};

export const DownloadActivity = createLiveActivity<DownloadActivityProps>(
  "DownloadActivity",
  (props) => {
    "widget";
    // The 'widget' directive serializes ONLY this function body into the
    // widget extension's own JS runtime: helpers must live inside it, and
    // module scope is unreachable (the @expo/ui components/modifiers above
    // exist there as globals). Props round-trip through JSON.
    // environment.colorScheme is always "light" in Live Activities
    // (expo/expo#47166), so colors are fixed rather than scheme-derived.
    const ACCENT = "#0A84FF";
    const count = `${props.completedTracks}/${props.totalTracks}`;
    const icon =
      props.phase === "downloading"
        ? "arrow.down.circle.fill"
        : props.phase === "partial"
          ? "exclamationmark.circle.fill"
          : "checkmark.circle.fill";
    const iconColor = props.phase === "partial" ? "#FF9F0A" : ACCENT;

    const bar = (
      <ProgressView
        value={props.progress}
        modifiers={[
          progressViewStyle("linear"),
          tint(ACCENT),
          labelsHidden(),
          frame({ maxWidth: Infinity }),
        ]}
      />
    );

    const subtitle =
      props.phase === "downloading"
        ? props.currentTrackTitle
        : props.failedTracks > 0
          ? `${props.failedTracks} ${props.failedTracks === 1 ? "track" : "tracks"} failed`
          : "All tracks downloaded";

    return {
      banner: (
        <VStack alignment="leading" spacing={6} modifiers={[
          padding({ all: 14 }),
          containerBackground("#1C1C1E", "widget"),
        ]}>
          <HStack spacing={6}>
            <Image systemName={icon} modifiers={[foregroundStyle(iconColor)]} />
            <Text modifiers={[font({ textStyle: "headline" }), foregroundStyle("#FFFFFF"), lineLimit(1)]}>
              {props.title}
            </Text>
            <Spacer />
            <Text modifiers={[font({ textStyle: "subheadline" }), monospacedDigit(), foregroundStyle("#EBEBF5")]}>
              {count}
            </Text>
          </HStack>
          <Text modifiers={[font({ textStyle: "caption" }), foregroundStyle({ type: "hierarchical", style: "secondary" }), lineLimit(1)]}>
            {subtitle}
          </Text>
          {bar}
        </VStack>
      ),
      compactLeading: (
        <Image systemName={icon} modifiers={[foregroundStyle(iconColor)]} />
      ),
      compactTrailing: (
        <Text modifiers={[font({ textStyle: "caption2" }), monospacedDigit()]}>
          {count}
        </Text>
      ),
      minimal: (
        <ProgressView
          value={props.progress}
          modifiers={[progressViewStyle("circular"), tint(ACCENT), labelsHidden()]}
        />
      ),
      expandedLeading: (
        <Image systemName={icon} modifiers={[foregroundStyle(iconColor), padding({ leading: 4 })]} />
      ),
      expandedCenter: (
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ textStyle: "headline" }), lineLimit(1)]}>
            {props.title}
          </Text>
          <Text modifiers={[font({ textStyle: "caption" }), foregroundStyle({ type: "hierarchical", style: "secondary" }), lineLimit(1)]}>
            {subtitle}
          </Text>
        </VStack>
      ),
      expandedTrailing: (
        <Text modifiers={[font({ textStyle: "subheadline" }), monospacedDigit(), padding({ trailing: 4 })]}>
          {count}
        </Text>
      ),
      expandedBottom: bar,
    };
  },
);
