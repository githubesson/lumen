import { useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type TextStyle,
} from "react-native";
import { useRouter } from "expo-router";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown } from "react-native-reanimated";
import { getBaseUrl } from "@music-library/core";
import { WELCOME_RECORD } from "../../components/auth/welcome-art";
import { WelcomeHero } from "../../components/auth/welcome-hero";
import { PrimaryButton } from "../../components/buttons";
import { useTheme } from "../../theme/theme";

const RECORD_SIZE = 32;
/** Room for the record, even when large text pushes the words up the screen. */
const HERO_MIN_HEIGHT = 240;
const ENTER = FadeInDown.delay(120)
  .duration(400)
  .withInitialValues({ opacity: 0, transform: [{ translateY: 12 }] });

/**
 * Where signed-out users land: a scene from Lumen's world over the headline,
 * then the two ways in (sign in, or register with an invite).
 */
export default function WelcomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  // The scene ends where the words start, whatever the screen and text size.
  const [wordsTop, setWordsTop] = useState<number | null>(null);
  const host = serverHost();

  const headline: TextStyle = {
    color: theme.color.fg,
    fontSize: 36,
    lineHeight: 44,
    fontWeight: "500",
    letterSpacing: -0.4,
  };
  const recordSize = RECORD_SIZE * Math.min(fontScale, 1.6);

  return (
    // Scrolls only when the content outgrows the screen (large text sizes);
    // otherwise the scene takes whatever height is left.
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.color.bg }}
      contentContainerStyle={{ flexGrow: 1 }}
      alwaysBounceVertical={false}
    >
      {wordsTop !== null ? (
        <WelcomeHero height={wordsTop + theme.space.md} />
      ) : null}

      <View style={{ flex: 1, minHeight: HERO_MIN_HEIGHT }} />

      <Animated.View
        entering={ENTER}
        onLayout={(event) => setWordsTop(Math.round(event.nativeEvent.layout.y))}
        style={{
          paddingHorizontal: theme.space.xl,
          paddingBottom: insets.bottom + theme.space.md,
        }}
      >
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel="Your music, on your server"
        >
          <Text style={headline}>Your music,</Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              columnGap: theme.space.sm,
            }}
          >
            <Text style={headline}>on your</Text>
            <Image
              source={WELCOME_RECORD}
              style={{ width: recordSize, height: recordSize }}
              contentFit="contain"
            />
            <Text style={headline}>server</Text>
          </View>
        </View>

        <Text
          style={{
            color: theme.color.fgMuted,
            fontSize: 15,
            lineHeight: 20,
            marginTop: theme.space.md,
          }}
        >
          Lumen plays your library from {host ?? "your server"} on your phone, in
          the car and offline
        </Text>

        <View style={{ marginTop: theme.space.xl }}>
          <PrimaryButton
            label="Sign in"
            tone="inverse"
            onPress={() => {
              void Haptics.selectionAsync();
              router.push("/(auth)/login");
            }}
          />
        </View>

        <Pressable
          onPress={() => {
            void Haptics.selectionAsync();
            router.push("/(auth)/register");
          }}
          accessibilityRole="button"
          accessibilityLabel="Create an account with an invite"
          style={({ pressed }) => ({
            alignItems: "center",
            marginTop: theme.space.xs,
            paddingVertical: theme.space.md,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: theme.color.fgSubtle, fontSize: 15 }}>
            I have an invite
          </Text>
        </Pressable>
      </Animated.View>
    </ScrollView>
  );
}

/** Host of the server this build talks to, for the subhead; null if unset. */
function serverHost(): string | null {
  try {
    return new URL(getBaseUrl()).hostname || null;
  } catch {
    return null;
  }
}
