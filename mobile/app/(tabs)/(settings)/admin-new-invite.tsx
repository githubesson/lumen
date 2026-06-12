import { useState } from "react";
import { Stack, useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type Role } from "@music-library/core";
import {
  FormError,
  FormField,
  FormTextInput,
} from "../../../components/form-field";
import { FormScreen } from "../../../components/form-screen";
import { HeaderTextButton } from "../../../components/header-buttons";
import { SegmentedControl } from "../../../components/segmented-control";
import { qk } from "../../../lib/query-keys";
import { useTheme } from "../../../theme/theme";

export default function AdminNewInviteScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [role, setRole] = useState<Role>("user");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresDays, setExpiresDays] = useState("7");

  const createMutation = useMutation({
    mutationFn: () => {
      const expiresAt =
        expiresDays && Number(expiresDays) > 0
          ? new Date(
              Date.now() + Number(expiresDays) * 24 * 60 * 60 * 1000,
            ).toISOString()
          : undefined;
      return api.createInvite({
        target_role: role,
        max_uses: maxUses ? Math.max(0, Number(maxUses)) : undefined,
        expires_at: expiresAt,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.adminInvites });
      router.back();
    },
  });

  return (
    <>
      <Stack.Screen
        options={{
          headerTransparent: false,
          headerStyle: { backgroundColor: theme.color.bg },
          contentStyle: { backgroundColor: theme.color.bg },
          headerLeft: () => (
            <HeaderTextButton label="Cancel" onPress={() => router.back()} />
          ),
          headerRight: () => (
            <HeaderTextButton
              label="Create"
              disabled={createMutation.isPending}
              onPress={() => createMutation.mutate()}
            />
          ),
        }}
      />
      <FormScreen>
        <FormField label="Role">
          <SegmentedControl<Role>
            options={[
              { label: "User", value: "user" },
              { label: "Admin", value: "admin" },
            ]}
            value={role}
            onChange={setRole}
          />
        </FormField>

        <FormField label="Max uses" hint="0 for unlimited">
          <FormTextInput
            value={maxUses}
            onChangeText={setMaxUses}
            keyboardType="number-pad"
          />
        </FormField>

        <FormField label="Expires in (days)" hint="Leave blank for no expiry">
          <FormTextInput
            value={expiresDays}
            onChangeText={setExpiresDays}
            keyboardType="number-pad"
          />
        </FormField>

        <FormError
          message={
            createMutation.isError
              ? errorMessage(createMutation.error, "Couldn't create invite.")
              : null
          }
        />
      </FormScreen>
    </>
  );
}
