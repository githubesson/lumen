import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { type TrackDetail } from "@music-library/core";
import { CoverArt } from "../cover-art";
import { formatDurationSec } from "../../lib/format";
import { useTheme } from "../../theme/theme";

/**
 * Cover, title, artist/album line, and duration for the track being shared.
 * Sits at the top of the share sheet so the user can confirm which track the
 * generated link points at.
 */
export function TrackHeader({
  track,
  style,
}: {
  track: TrackDetail;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const artist =
    track.artists.find((item) => item.role === "primary")?.name ??
    track.artists[0]?.name ??
    "Unknown artist";

  return (
    <View style={[styles.header, { gap: theme.space.md }, style]}>
      <CoverArt track={track} size={72} priority="high" />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={2}
          style={{ color: theme.color.fg, fontSize: 22, fontWeight: "700" }}
        >
          {track.title}
        </Text>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fgMuted, fontSize: 16 }}
        >
          {artist}
          {track.album_title ? ` - ${track.album_title}` : ""}
        </Text>
        <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
          {formatDurationSec(Math.floor(track.duration_ms / 1000))}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
});
