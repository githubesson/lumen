import { validateRegistrationInput } from "@music-library/core/auth/validation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ApiError, api, useAuth, type Role } from "@music-library/core";
import { PrimaryButton } from "../../components/buttons";
import {
  FormError,
  FormField,
  FormTextInput,
} from "../../components/form-field";
import { FormScreen } from "../../components/form-screen";
import {
  extractInviteToken,
} from "../../lib/invite-registration";
import { useTheme } from "../../theme/theme";

type InviteSource = "route" | "manual";

type InviteState =
  | { status: "entry" }
  | { status: "checking"; token: string; source: InviteSource }
  | { status: "valid"; token: string; role: Role; source: InviteSource }
  | { status: "invalid"; token: string; source: InviteSource }
  | {
      status: "verification-error";
      token: string;
      source: InviteSource;
    };

/**
 * Invite-only registration. Deep links verify their token immediately; users
 * arriving from sign-in can paste either the raw token or a complete invite
 * link. Registration returns the user alongside the new session cookie; the
 * auth provider adopts both so the root AuthGate can redirect to the library.
 */
export default function RegisterScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { token: routeTokenParam } = useLocalSearchParams<{
    token?: string | string[];
  }>();
  const { setMe } = useAuth();

  const routeTokenValue = Array.isArray(routeTokenParam)
    ? routeTokenParam[0]
    : routeTokenParam;
  const routeToken = extractInviteToken(routeTokenValue ?? "");

  const [inviteInput, setInviteInput] = useState("");
  const [inviteInputError, setInviteInputError] = useState<string | null>(null);
  const [inviteState, setInviteState] = useState<InviteState>(() =>
    routeToken
      ? { status: "checking", token: routeToken, source: "route" }
      : { status: "entry" },
  );
  const [ignoredRouteToken, setIgnoredRouteToken] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkRequestRef = useRef(0);

  const finishInviteVerification = useCallback(
    async (token: string, source: InviteSource, request: number) => {
      try {
        const result = await api.checkInvite(token);
        if (request !== checkRequestRef.current) return;
        if (result.valid) {
          setInviteState({
            status: "valid",
            token,
            role: result.target_role ?? "user",
            source,
          });
        } else {
          setInviteState({ status: "invalid", token, source });
        }
      } catch {
        if (request !== checkRequestRef.current) return;
        setInviteState({ status: "verification-error", token, source });
      }
    },
    [],
  );

  const verifyInvite = useCallback(
    (token: string) => {
      const request = ++checkRequestRef.current;
      setInviteInputError(null);
      setError(null);
      setInviteState({ status: "checking", token, source: "manual" });
      void finishInviteVerification(token, "manual", request);
    },
    [finishInviteVerification],
  );

  useEffect(() => {
    if (!routeToken) return;
    const request = ++checkRequestRef.current;
    void finishInviteVerification(routeToken, "route", request);
  }, [routeToken, finishInviteVerification]);

  useEffect(
    () => () => {
      checkRequestRef.current += 1;
    },
    [],
  );

  const routeTokenIsChecking =
    !!routeToken &&
    routeToken !== ignoredRouteToken &&
    (inviteState.status === "entry" || inviteState.token !== routeToken);
  const routeTokenWasRemoved =
    !routeToken &&
    inviteState.status !== "entry" &&
    inviteState.source === "route";
  const activeInviteState: InviteState = routeTokenIsChecking
    ? { status: "checking", token: routeToken, source: "route" }
    : routeTokenWasRemoved
      ? { status: "entry" }
      : inviteState;

  const onContinue = () => {
    const token = extractInviteToken(inviteInput);
    if (!token) {
      setInviteInputError("Paste a valid invite token or registration link.");
      return;
    }
    void verifyInvite(token);
  };

  const enterAnotherInvite = () => {
    checkRequestRef.current += 1;
    if (routeToken) setIgnoredRouteToken(routeToken);
    setInviteInput(
      "token" in activeInviteState ? activeInviteState.token : "",
    );
    setInviteInputError(null);
    setError(null);
    setInviteState({ status: "entry" });
  };

  const validation = validateRegistrationInput(username, password);
  const onSubmit = async () => {
    if (
      activeInviteState.status !== "valid" ||
      !validation.valid ||
      pending
    )
      return;
    setError(null);
    setPending(true);
    try {
      const me = await api.register(
        activeInviteState.token,
        validation.username,
        password,
      );
      setMe(me);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // AuthGate observes the adopted session and redirects automatically.
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(registrationErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <FormScreen variant="centered">
      <View style={{ gap: theme.space.xs }}>
        <Text
          accessibilityRole="header"
          style={{
            fontSize: 34,
            fontWeight: "700",
            color: theme.color.fg,
            letterSpacing: -0.4,
          }}
        >
          {activeInviteState.status === "invalid" ||
          activeInviteState.status === "verification-error"
            ? "Invite unavailable"
            : "Create your account"}
        </Text>

        {activeInviteState.status === "entry" ? (
          <Text style={{ fontSize: 16, color: theme.color.fgMuted }}>
            Lumen accounts are invite-only. Paste the invite you received to
            continue.
          </Text>
        ) : activeInviteState.status === "checking" ? (
          <View
            accessibilityLiveRegion="polite"
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <ActivityIndicator color={theme.color.fgMuted} />
            <Text style={{ fontSize: 16, color: theme.color.fgMuted }}>
              Checking invite…
            </Text>
          </View>
        ) : activeInviteState.status === "valid" ? (
          <Text style={{ fontSize: 16, color: theme.color.fgMuted }}>
            You&apos;ve been invited as{" "}
            <Text style={{ color: theme.color.fg, fontWeight: "600" }}>
              {activeInviteState.role}
            </Text>
            .
          </Text>
        ) : activeInviteState.status === "invalid" ? (
          <Text
            selectable
            accessibilityLiveRegion="assertive"
            style={{ fontSize: 16, color: theme.color.danger }}
          >
            This invite is invalid, expired, revoked, or has no uses remaining.
          </Text>
        ) : (
          <Text
            accessibilityLiveRegion="assertive"
            style={{ fontSize: 16, color: theme.color.danger }}
          >
            Couldn&apos;t verify this invite. Check your connection and try again.
          </Text>
        )}
      </View>

      {activeInviteState.status === "entry" ? (
        <>
          <FormField
            label="Invite token or link"
            hint="Paste the token or Lumen invite link you received."
          >
            <FormTextInput
              accessibilityLabel="Invite token or link"
              placeholder="Invite token or link"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              value={inviteInput}
              onChangeText={(value) => {
                setInviteInput(value);
                if (inviteInputError) setInviteInputError(null);
              }}
              onSubmitEditing={onContinue}
            />
          </FormField>
          <View accessibilityLiveRegion="assertive">
            <FormError message={inviteInputError} />
          </View>
          <PrimaryButton
            label="Continue"
            onPress={onContinue}
            disabled={!inviteInput.trim()}
          />
        </>
      ) : null}

      {activeInviteState.status === "invalid" ? (
        <PrimaryButton label="Enter another invite" onPress={enterAnotherInvite} />
      ) : null}

      {activeInviteState.status === "verification-error" ? (
        <>
          <PrimaryButton
            label="Try again"
            onPress={() => void verifyInvite(activeInviteState.token)}
          />
          <TextAction label="Enter another invite" onPress={enterAnotherInvite} />
        </>
      ) : null}

      {activeInviteState.status === "valid" ? (
        <>
          <View style={{ gap: theme.space.md }}>
            <FormField label="Username" hint="2 characters or more.">
              <FormTextInput
                accessibilityLabel="Username"
                placeholder="Username"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username-new"
                textContentType="username"
                value={username}
                onChangeText={setUsername}
                editable={!pending}
                returnKeyType="next"
              />
              <FormError
                message={username ? validation.usernameError : null}
              />
            </FormField>
            <FormField label="Password" hint="At least 8 characters, up to 256 bytes.">
              <FormTextInput
                accessibilityLabel="Password"
                placeholder="Password"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="password-new"
                textContentType="newPassword"
                secureTextEntry
                maxLength={256}
                value={password}
                onChangeText={setPassword}
                editable={!pending}
                onSubmitEditing={onSubmit}
              />
              <FormError
                message={password ? validation.passwordError : null}
              />
            </FormField>
          </View>

          <View accessibilityLiveRegion="assertive">
            <FormError message={error} />
          </View>

          <PrimaryButton
            label="Create account"
            onPress={onSubmit}
            loading={pending}
            disabled={!validation.valid}
          />
        </>
      ) : null}

      <TextAction
        label="Already have an account? Sign in"
        onPress={() => router.replace("/(auth)/login")}
      />
    </FormScreen>
  );
}

function TextAction({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        alignItems: "center",
        paddingVertical: 8,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ color: theme.color.accent, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

function registrationErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return "That username is already taken.";
    if (err.status === 429) {
      return "Too many registration attempts. Try again later.";
    }
    if (err.message.includes("invite")) {
      return "This invite is no longer usable. Enter another invite and try again.";
    }
    return err.message || `Registration failed (${err.status}).`;
  }
  return "Couldn't create your account. Check your connection and try again.";
}
