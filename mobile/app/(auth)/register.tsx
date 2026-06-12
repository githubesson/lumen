import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ApiError,
  api,
  useAuth,
  type InviteCheck,
} from "@music-library/core";
import { PrimaryButton } from "../../components/buttons";
import { FormError, FormTextInput } from "../../components/form-field";
import { FormScreen } from "../../components/form-screen";
import { useTheme } from "../../theme/theme";

/**
 * Register flow for users with an invite token. The token arrives as a route
 * param (deep link or manual navigation); we validate it once on mount so the
 * user sees a meaningful error quickly if it's expired/revoked. On success,
 * `AuthProvider`'s `setMe` flips status → "authed" and `AuthGate` pushes into
 * (tabs).
 */
export default function RegisterScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { refresh } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [check, setCheck] = useState<InviteCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setCheck({ valid: false });
        setChecking(false);
        return;
      }
      try {
        const result = await api.checkInvite(token);
        if (!cancelled) {
          setCheck(result);
          setChecking(false);
        }
      } catch {
        if (!cancelled) {
          setCheck({ valid: false });
          setChecking(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onSubmit = async () => {
    if (!token || !username || !password || pending) return;
    setError(null);
    setPending(true);
    try {
      await api.register(token, username, password);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refresh();
      // AuthGate observes status and redirects to (tabs) automatically.
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (err instanceof ApiError) {
        setError(err.message || `Registration failed (${err.status}).`);
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
    <FormScreen variant="centered">
      <View style={{ gap: theme.space.xs }}>
        <Text
          style={{
            fontSize: 34,
            fontWeight: "700",
            color: theme.color.fg,
            letterSpacing: -0.4,
          }}
        >
          Create your account
        </Text>
        {checking ? (
          <Text style={{ fontSize: 16, color: theme.color.fgMuted }}>
            Checking invite…
          </Text>
        ) : check?.valid ? (
          <Text style={{ fontSize: 16, color: theme.color.fgMuted }}>
            You&apos;ve been invited as{" "}
            <Text style={{ color: theme.color.fg, fontWeight: "600" }}>
              {check.target_role ?? "user"}
            </Text>
            .
          </Text>
        ) : (
          <Text selectable style={{ fontSize: 16, color: theme.color.danger }}>
            This invite link is invalid, expired, or already used.
          </Text>
        )}
      </View>

      {check?.valid ? (
        <>
          <View style={{ gap: theme.space.md }}>
            <FormTextInput
              placeholder="Username"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username-new"
              textContentType="username"
              value={username}
              onChangeText={setUsername}
              editable={!pending}
            />
            <FormTextInput
              placeholder="Password"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password-new"
              textContentType="newPassword"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              editable={!pending}
              onSubmitEditing={onSubmit}
            />
          </View>

          <FormError message={error} />

          <PrimaryButton
            label="Create account"
            onPress={onSubmit}
            loading={pending}
            disabled={!username || !password}
          />
        </>
      ) : null}

      <Pressable
        onPress={() => router.replace("/(auth)/login")}
        style={({ pressed }) => ({
          alignItems: "center",
          paddingVertical: 8,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ color: theme.color.accent, fontSize: 15 }}>
          Already have an account? Sign in
        </Text>
      </Pressable>
    </FormScreen>
  );
}
