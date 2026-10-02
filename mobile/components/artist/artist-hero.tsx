import { Text, View } from "react-native";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { Eyebrow } from "../eyebrow";
import { displayText } from "@music-library/core";
import { useTheme } from "../../theme/theme";

export const ARTIST_AVATAR_SIZE = 168;

// The backdrop extends above the header's content inset so the tinted wash
// continues under the transparent navigation bar and the pull-down bounce.
const BACKDROP_BLEED = 400;

/**
 * Artist banner: the artist image blurred into a wash behind a round avatar,
 * then the kind label and the name. A scrim fades the wash into the page
 * background so the name keeps contrast in both schemes.
 */
export function ArtistHero({
  name,
  kind,
  imageUri,
}: {
  name: string;
  kind: string;
  imageUri: string | null;
}) {
  const theme = useTheme();
  const scrim = theme.scheme === "dark" ? "0, 0, 0" : "255, 255, 255";
  return (
    <View
      style={{
        alignItems: "center",
        gap: theme.space.md,
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.xl,
        paddingBottom: theme.space.lg,
      }}
    >
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: -BACKDROP_BLEED,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "hidden",
          backgroundColor: theme.color.bgElev1,
        }}
      >
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={{ flex: 1, opacity: 0.75 }}
            contentFit="cover"
            blurRadius={48}
            cachePolicy="memory-disk"
            transition={200}
          />
        ) : null}
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            experimental_backgroundImage: `linear-gradient(to bottom, rgba(${scrim}, 0.1) 0%, rgba(${scrim}, 0.45) 70%, rgba(${scrim}, 1) 100%)`,
          }}
        />
      </View>
      <View
        style={{
          width: ARTIST_AVATAR_SIZE,
          height: ARTIST_AVATAR_SIZE,
          borderRadius: ARTIST_AVATAR_SIZE / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.color.bgElev2,
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.35)",
        }}
      >
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={{
              width: ARTIST_AVATAR_SIZE,
              height: ARTIST_AVATAR_SIZE,
              borderRadius: ARTIST_AVATAR_SIZE / 2,
            }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={200}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <SymbolView
            name="person.fill"
            size={72}
            tintColor={theme.color.fgMuted}
          />
        )}
      </View>
      <View style={{ alignItems: "center", gap: 4 }}>
        <Eyebrow>{kind}</Eyebrow>
        <Text
          selectable
          numberOfLines={2}
          accessibilityRole="header"
          style={{
            color: theme.color.fg,
            fontSize: 34,
            fontWeight: "800",
            letterSpacing: -0.8,
            textAlign: "center",
          }}
        >
          {displayText(name)}
        </Text>
      </View>
    </View>
  );
}
