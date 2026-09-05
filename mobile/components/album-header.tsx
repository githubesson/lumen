import { Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/theme";

export const ALBUM_ART_SIZE = 220;

interface Props {
  title: string;
  artist?: string | null;
  coverUri: string | null;
  coverKey?: string;
  metadata: string;
  onPlay?: () => void;
}

export function AlbumHeader({
  title,
  artist,
  coverUri,
  coverKey,
  metadata,
  onPlay,
}: Props) {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: theme.space.lg,
        paddingBottom: theme.space.md,
      }}
    >
      <View
        style={{
          alignItems: "center",
          paddingVertical: theme.space.xl,
          gap: theme.space.md,
        }}
      >
        <View
          style={{
            width: ALBUM_ART_SIZE,
            height: ALBUM_ART_SIZE,
            borderRadius: theme.radius.lg,
            overflow: "hidden",
            borderCurve: "continuous",
            backgroundColor: theme.color.bgElev2,
          }}
        >
          {coverUri ? (
            <Image
              source={{ uri: coverUri }}
              style={{ width: ALBUM_ART_SIZE, height: ALBUM_ART_SIZE }}
              contentFit="cover"
              transition={120}
              cachePolicy="memory-disk"
              allowDownscaling
              decodeFormat="rgb"
              recyclingKey={coverKey ?? coverUri}
            />
          ) : null}
        </View>
        <View style={{ alignItems: "center", gap: 2 }}>
          <Text
            style={{
              fontSize: 22,
              fontWeight: "700",
              color: theme.color.fg,
              letterSpacing: -0.2,
              textAlign: "center",
            }}
            numberOfLines={2}
          >
            {title}
          </Text>
          {artist ? (
            <Text
              style={{ fontSize: 16, color: theme.color.fgMuted }}
              numberOfLines={1}
            >
              {artist}
            </Text>
          ) : null}
          <Text
            style={{ fontSize: 13, color: theme.color.fgMuted, marginTop: 4 }}
          >
            {metadata}
          </Text>
        </View>
      </View>
      {!!onPlay ? (
        <Pressable
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onPlay();
          }}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            backgroundColor: theme.color.accent,
            borderRadius: theme.radius.md,
            paddingVertical: 12,
            opacity: pressed ? 0.85 : 1,
            borderCurve: "continuous",
          })}
        >
          <SymbolView
            name="play.fill"
            size={14}
            tintColor={theme.color.onAccent}
          />
          <Text
            style={{
              color: theme.color.onAccent,
              fontWeight: "600",
              fontSize: 15,
            }}
          >
            Play
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
