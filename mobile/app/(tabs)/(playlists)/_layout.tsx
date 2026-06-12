import { Stack } from "expo-router";
import { stackScreenOptions } from "../../../theme/stack-options";

export default function PlaylistsStackLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: "Playlists" }} />
      <Stack.Screen
        name="[id]"
        options={{ headerLargeTitle: false, title: "" }}
      />
      <Stack.Screen
        name="new"
        options={{
          headerLargeTitle: false,
          title: "New Playlist",
        }}
      />
      <Stack.Screen
        name="edit/[id]"
        options={{
          headerLargeTitle: false,
          title: "Edit Playlist",
        }}
      />
      <Stack.Screen
        name="collaborators/[id]"
        options={{ headerLargeTitle: false, title: "Collaborators" }}
      />
      <Stack.Screen
        name="invite-collaborator"
        options={{
          headerLargeTitle: false,
          title: "Invite Collaborator",
        }}
      />
    </Stack>
  );
}
