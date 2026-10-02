import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import {
  api,
  passwordChangeErrorMessage,
  useAuth,
  validatePasswordChange,
} from "@music-library/core";
import { PrimaryButton } from "../../components/buttons";
import { FormError, FormTextInput } from "../../components/form-field";
import { FormScreen } from "../../components/form-screen";
import { useTheme } from "../../theme/theme";

/**
 * Required when the backend sets `must_reset_password` (e.g. admin-issued
 * temporary password). Blocks tab navigation until the user sets a new
 * password; auth-gate routes here via the `(auth)` group while status is
 * authed-with-reset.
 */
export default function ResetPasswordScreen() {
  const theme = useTheme();
  const { refresh, logout } = useAuth();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = validatePasswordChange(current, next, confirm);
  // Only once there's something to judge, as on registration.
  const passwordError = next ? validation.passwordError : null;
  const mismatch = confirm ? validation.confirmError : null;
  const canSubmit = validation.valid && !pending;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setPending(true);
    try {
      await api.resetPassword(current, next);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Refresh so must_reset_password flips false; AuthGate then routes to tabs.
      await refresh();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(passwordChangeErrorMessage(err));
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
          Set a new password
        </Text>
        <Text style={{ fontSize: 16, color: theme.color.fgMuted }}>
          Choose a new password before continuing.
        </Text>
      </View>

      <View style={{ gap: theme.space.md }}>
        <FormTextInput
          placeholder="Current password"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          secureTextEntry
          value={current}
          onChangeText={setCurrent}
          editable={!pending}
        />
        <FormTextInput
          placeholder="New password"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password-new"
          textContentType="newPassword"
          secureTextEntry
          value={next}
          onChangeText={setNext}
          editable={!pending}
        />
        <FormError message={passwordError} />
        <FormTextInput
          placeholder="Confirm new password"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password-new"
          textContentType="newPassword"
          secureTextEntry
          value={confirm}
          onChangeText={setConfirm}
          editable={!pending}
          onSubmitEditing={onSubmit}
          style={
            mismatch ? { borderWidth: 1, borderColor: theme.color.danger } : null
          }
        />
        <FormError message={mismatch} />
      </View>

      <FormError message={error} />

      <PrimaryButton
        label="Update password"
        onPress={onSubmit}
        loading={pending}
        disabled={!canSubmit}
      />

      <Pressable
        onPress={() => void logout()}
        style={({ pressed }) => ({
          alignItems: "center",
          paddingVertical: 8,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ color: theme.color.fgMuted, fontSize: 14 }}>
          Sign out
        </Text>
      </Pressable>
    </FormScreen>
  );
}
