import { Stack } from "expo-router";
import { stackScreenOptions } from "../../../theme/stack-options";

export default function SettingsStackLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: "Settings" }} />
      <Stack.Screen
        name="replay"
        options={{ headerLargeTitle: false, title: "Replay" }}
      />
      <Stack.Screen
        name="albums/[id]"
        options={{ headerLargeTitle: false, title: "" }}
      />
      <Stack.Screen
        name="artists/[id]"
        options={{ headerLargeTitle: false, title: "" }}
      />
      <Stack.Screen
        name="admin-invites"
        options={{ headerLargeTitle: false, title: "Invitations" }}
      />
      <Stack.Screen
        name="admin-library"
        options={{ headerLargeTitle: false, title: "Library" }}
      />
      <Stack.Screen
        name="admin-new-invite"
        options={{
          headerLargeTitle: false,
          title: "New Invitation",
        }}
      />
      <Stack.Screen
        name="admin-add-root"
        options={{
          headerLargeTitle: false,
          title: "Add Music Root",
        }}
      />
    </Stack>
  );
}
