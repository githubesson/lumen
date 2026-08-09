import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Share as NativeShare,
  Text,
  View,
} from "react-native";
import { Stack, useNavigation, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type Invite, type Role } from "@music-library/core";
import { PrimaryButton, SecondaryButton } from "../../../components/buttons";
import {
  FormError,
  FormField,
  FormTextInput,
} from "../../../components/form-field";
import { FormScreen } from "../../../components/form-screen";
import { HeaderTextButton } from "../../../components/header-buttons";
import { SegmentedControl } from "../../../components/segmented-control";
import {
  buildInviteRegistrationUrl,
  buildInviteShareMessage,
  validateInviteCreationInput,
} from "../../../lib/invite-registration";
import { qk } from "../../../lib/query-keys";
import { useTheme } from "../../../theme/theme";

export default function AdminNewInviteScreen() {
  const theme = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();

  const [role, setRole] = useState<Role>("user");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresDays, setExpiresDays] = useState("7");
  const [created, setCreated] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const unsharedTokenRef = useRef<string | null>(null);
  const allowRemovalRef = useRef(false);

  const validation = validateInviteCreationInput(maxUses, expiresDays);

  const createMutation = useMutation({
    mutationFn: () =>
      api.createInvite({
        target_role: role,
        max_uses: validation.maxUses ?? undefined,
        expires_at: validation.expiresAt,
      }),
    onSuccess: (invite) => {
      void queryClient.invalidateQueries({ queryKey: qk.adminInvites });
      if (!invite.token) {
        setActionError(
          "The invite was created, but its one-time token wasn't returned. Create a new invite.",
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      unsharedTokenRef.current = invite.token;
      setCreated(invite);
      setActionError(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    },
    onSettled: () => {
      creatingRef.current = false;
    },
  });

  const onCreate = () => {
    if (
      !validation.valid ||
      creatingRef.current ||
      createMutation.isPending
    )
      return;
    creatingRef.current = true;
    setActionError(null);
    createMutation.mutate();
  };

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (allowRemovalRef.current) {
          allowRemovalRef.current = false;
          return;
        }
        if (creatingRef.current) {
          event.preventDefault();
          Alert.alert(
            "Creating invitation",
            "Wait for the invitation to finish so its one-time token isn't lost.",
          );
          return;
        }
        if (!unsharedTokenRef.current) return;

        event.preventDefault();
        Alert.alert(
          "Leave without sharing?",
          "This invite token won't be shown again.",
          [
            { text: "Keep invite", style: "cancel" },
            {
              text: "Leave",
              style: "destructive",
              onPress: () => {
                unsharedTokenRef.current = null;
                allowRemovalRef.current = true;
                navigation.dispatch(event.data.action);
              },
            },
          ],
        );
      }),
    [navigation],
  );

  const copyLink = async () => {
    if (!created?.token) return;
    setActionError(null);
    try {
      await Clipboard.setStringAsync(buildInviteRegistrationUrl(created.token));
      setCopied(true);
      unsharedTokenRef.current = null;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setActionError(
        "Couldn't copy the invite link. Select the link above to copy it manually.",
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const shareInvite = async () => {
    if (!created?.token || sharing) return;
    setActionError(null);
    setSharing(true);
    const url = buildInviteRegistrationUrl(created.token);
    try {
      const result = await NativeShare.share({
        title: "Lumen invitation",
        message: buildInviteShareMessage(created.token),
        url,
      });
      if (result.action === NativeShare.sharedAction) {
        unsharedTokenRef.current = null;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err) {
      if (!isShareDismissal(err)) {
        setActionError("Couldn't open the share sheet. Copy the invite link instead.");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: created ? "Invite ready" : "New invitation",
          headerTransparent: false,
          headerStyle: { backgroundColor: theme.color.bg },
          contentStyle: { backgroundColor: theme.color.bg },
          headerLeft: () => (
            <HeaderTextButton
              label={created ? "Done" : "Cancel"}
              disabled={createMutation.isPending}
              onPress={() => router.back()}
            />
          ),
          headerRight: () =>
            created ? null : (
              <HeaderTextButton
                label="Create"
                disabled={!validation.valid || createMutation.isPending}
                onPress={onCreate}
              />
            ),
        }}
      />

      {created?.token ? (
        <FormScreen>
          <View
            accessibilityLiveRegion="polite"
            style={{ gap: theme.space.xs }}
          >
            <Text
              accessibilityRole="header"
              style={{ color: theme.color.fg, fontSize: 24, fontWeight: "700" }}
            >
              Invite ready
            </Text>
            <Text style={{ color: theme.color.fgMuted, fontSize: 15 }}>
              Copy or share it now. The token won&apos;t be shown again after you
              leave this screen.
            </Text>
            <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
              {created.target_role === "admin" ? "Admin" : "User"} ·{" "}
              {created.max_uses} {created.max_uses === 1 ? "use" : "uses"}
              {created.expires_at
                ? ` · expires ${new Date(created.expires_at).toLocaleDateString()}`
                : " · no expiry"}
            </Text>
          </View>

          <FormField
            label="Registration link"
            hint="Opens Lumen directly when the app is installed."
          >
            <InviteValue value={buildInviteRegistrationUrl(created.token)} />
          </FormField>

          <FormField
            label="Invite token"
            hint="The recipient can paste this in Lumen if the link doesn't open."
          >
            <InviteValue value={created.token} />
          </FormField>

          <View accessibilityLiveRegion="assertive">
            <FormError message={actionError} />
          </View>

          <PrimaryButton
            label="Share invite"
            onPress={() => void shareInvite()}
            loading={sharing}
          />
          <SecondaryButton
            label={copied ? "Copied" : "Copy link"}
            onPress={() => void copyLink()}
            disabled={copied || sharing}
          />
        </FormScreen>
      ) : (
        <FormScreen>
          <FormField label="Role">
            <SegmentedControl<Role>
              options={[
                { label: "User", value: "user" },
                { label: "Admin", value: "admin" },
              ]}
              value={role}
              onChange={setRole}
              disabled={createMutation.isPending}
            />
          </FormField>

          <FormField label="Max uses" hint="Whole number from 1 to 2,147,483,647.">
            <FormTextInput
              accessibilityLabel="Maximum invite uses"
              value={maxUses}
              onChangeText={setMaxUses}
              keyboardType="number-pad"
              editable={!createMutation.isPending}
            />
            <FormError message={validation.maxUsesError} />
          </FormField>

          <FormField
            label="Expires in (days)"
            hint="Leave blank for no expiry."
          >
            <FormTextInput
              accessibilityLabel="Invite expiry in days"
              value={expiresDays}
              onChangeText={setExpiresDays}
              keyboardType="number-pad"
              editable={!createMutation.isPending}
            />
            <FormError message={validation.expiresDaysError} />
          </FormField>

          <View accessibilityLiveRegion="assertive">
            <FormError
              message={
                actionError ??
                (createMutation.isError
                  ? errorMessage(createMutation.error, "Couldn't create invite.")
                  : null)
              }
            />
          </View>
        </FormScreen>
      )}
    </>
  );
}

function InviteValue({ value }: { value: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.color.bgElev1,
        borderRadius: theme.radius.md,
        borderCurve: "continuous",
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <Text
        selectable
        style={{
          color: theme.color.fg,
          fontSize: 13,
          fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function isShareDismissal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("dismiss") ||
    message.includes("did not share")
  );
}
