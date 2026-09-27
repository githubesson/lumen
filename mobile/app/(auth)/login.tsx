import { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  View,
  type TextInput,
} from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { ApiError, useAuth } from "@music-library/core";
import { PrimaryButton } from "../../components/buttons";
import { FormError, FormTextInput } from "../../components/form-field";
import { useTheme } from "../../theme/theme";

/**
 * Sign-in form, pushed from the welcome screen. The fields sit under the
 * header and the button stays pinned just above the keyboard.
 */
export default function LoginScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const reducedMotion = useReducedMotion();
  const passwordRef = useRef<TextInput>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shake = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shake.value }],
  }));

  const onSubmit = async () => {
    if (!username || !password || pending) return;
    setError(null);
    setPending(true);
    try {
      await login(username, password);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // AuthGate in the root layout will observe the status change and
      // replace the route to (tabs)/(library).
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (!reducedMotion) {
        shake.set(
          withSequence(
            withTiming(-12, { duration: 50 }),
            withTiming(12, { duration: 70 }),
            withTiming(-8, { duration: 70 }),
            withTiming(8, { duration: 70 }),
            withTiming(-3, { duration: 60 }),
            withTiming(0, { duration: 50 }),
          ),
        );
      }
      if (err instanceof ApiError && err.status === 401) {
        setError("Wrong username or password.");
      } else if (err instanceof Error) {
        setError(err.message || "Couldn't reach the server.");
      } else {
        setError("Couldn't reach the server.");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}
      // The button already clears the home indicator; over the keyboard that
      // inset would just be a gap.
      keyboardVerticalOffset={-insets.bottom}
      style={{ flex: 1, backgroundColor: theme.color.bg }}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: theme.space.xl,
          paddingTop: theme.space.lg,
          gap: theme.space.lg,
        }}
      >
        <Animated.View style={[{ gap: theme.space.md }, shakeStyle]}>
          <FormTextInput
            placeholder="Username"
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="next"
            submitBehavior="submit"
            value={username}
            onChangeText={setUsername}
            onSubmitEditing={() => passwordRef.current?.focus()}
            editable={!pending}
          />
          <FormTextInput
            ref={passwordRef}
            placeholder="Password"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={onSubmit}
            editable={!pending}
          />
        </Animated.View>

        <FormError message={error} />

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
      </ScrollView>

      <View
        style={{
          paddingHorizontal: theme.space.xl,
          paddingTop: theme.space.md,
          paddingBottom: insets.bottom + theme.space.md,
        }}
      >
        <PrimaryButton
          label="Sign in"
          onPress={onSubmit}
          loading={pending}
          disabled={!username || !password}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
