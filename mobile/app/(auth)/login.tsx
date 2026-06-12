import { useState } from "react";
import { Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { ApiError, useAuth } from "@music-library/core";
import { PrimaryButton } from "../../components/buttons";
import { FormError, FormTextInput } from "../../components/form-field";
import { FormScreen } from "../../components/form-screen";
import { useTheme } from "../../theme/theme";

export default function LoginScreen() {
  const theme = useTheme();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          Lumen
        </Text>
        <Text style={{ fontSize: 16, color: theme.color.fgMuted }}>
          Sign in to your library.
        </Text>
      </View>

      <View style={{ gap: theme.space.md }}>
        <FormTextInput
          placeholder="Username"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          value={username}
          onChangeText={setUsername}
          editable={!pending}
        />
        <FormTextInput
          placeholder="Password"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          editable={!pending}
          onSubmitEditing={onSubmit}
        />
      </View>

      <FormError message={error} />

      <PrimaryButton
        label="Sign in"
        onPress={onSubmit}
        loading={pending}
        disabled={!username || !password}
      />
    </FormScreen>
  );
}
