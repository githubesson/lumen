import { Stack } from "expo-router";
import { stackScreenOptions } from "../../../theme/stack-options";

export default function LibraryStackLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: "Home" }} />
      <Stack.Screen name="browse" options={{ title: "Browse" }} />
      <Stack.Screen
        name="albums/[id]"
        options={{ headerLargeTitle: false, title: "" }}
      />
      <Stack.Screen
        name="tidal-albums/[id]"
        options={{ headerLargeTitle: false, title: "" }}
      />
      <Stack.Screen
        name="artists/[id]"
        options={{ headerLargeTitle: false, title: "" }}
      />
      <Stack.Screen
        name="track/[id]"
        options={{ headerLargeTitle: false, title: "Track Info" }}
      />
      <Stack.Screen
        name="track/edit"
        options={{ headerLargeTitle: false, title: "Edit Track" }}
      />
      <Stack.Screen
        name="albums/edit"
        options={{ headerLargeTitle: false, title: "Edit Album" }}
      />
      <Stack.Screen
        name="upload"
        options={{ headerLargeTitle: false, title: "Upload" }}
      />
    </Stack>
  );
}
