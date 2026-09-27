import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { getBaseUrl } from "@music-library/core";
import { BouncingTitle } from "../../components/auth/bouncing-title";
import { BubbleParade } from "../../components/auth/bubble-parade";
import { useAuthMotionClock } from "../../components/auth/motion";
import { PrimaryButton } from "../../components/buttons";
import { useTheme } from "../../theme/theme";

/**
 * Where signed-out users land: the wordmark, a parade of glass bubbles drifting
 * across the upper half, and the two ways in (sign in, or register with an invite).
 */
export default function WelcomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const clock = useAuthMotionClock();
  const host = serverHost();

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <View style={{ paddingTop: insets.top + theme.space.lg, alignItems: "center" }}>
        <BouncingTitle
          text="Lumen"
          clock={clock}
          style={{
            fontSize: 28,
            fontWeight: "700",
            color: theme.color.fg,
            letterSpacing: -0.4,
          }}
        />
      </View>

      <BubbleParade clock={clock} style={{ flex: 1 }} />

      <View
        style={{
          paddingHorizontal: theme.space.xl,
          paddingBottom: insets.bottom + theme.space.md,
          gap: theme.space.xl,
        }}
      >
        <Animated.View
          entering={FadeInDown.delay(250).duration(500)}
          style={{ gap: theme.space.sm }}
        >
          <Text
            style={{
              fontSize: 34,
              fontWeight: "700",
              color: theme.color.fg,
              letterSpacing: -0.4,
              textAlign: "center",
            }}
          >
            {"Your music library,\nlit up."}
          </Text>
          <Text
            style={{ fontSize: 16, color: theme.color.fgMuted, textAlign: "center" }}
          >
            Sign in to your server, or join with an invite.
          </Text>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.delay(380).duration(500)}
          style={{ gap: theme.space.md }}
        >
          <PrimaryButton
            label="Sign in"
            onPress={() => {
              void Haptics.selectionAsync();
              router.push("/(auth)/login");
            }}
          />
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.push("/(auth)/register");
            }}
            accessibilityRole="button"
            accessibilityLabel="Create an account with an invite"
            style={({ pressed }) => ({
              alignItems: "center",
              paddingVertical: 8,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ color: theme.color.accent, fontSize: 15 }}>
              Have an invite? Create an account
            </Text>
          </Pressable>
        </Animated.View>

        <Animated.Text
          entering={FadeIn.delay(600).duration(400)}
          style={{ fontSize: 13, color: theme.color.fgMuted, textAlign: "center" }}
        >
          {host ? (
            <>
              Accounts on <Text style={{ color: theme.color.fg }}>{host}</Text>{" "}
              are invite-only.
            </>
          ) : (
            "Accounts are invite-only."
          )}
        </Animated.Text>
      </View>
    </View>
  );
}

/** Host of the server this build talks to, for the footer; null if unset. */
function serverHost(): string | null {
  try {
    return new URL(getBaseUrl()).hostname || null;
  } catch {
    return null;
  }
}
