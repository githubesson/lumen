import { Stack } from "expo-router";
import { stackScreenOptions } from "../../../theme/stack-options";

export default function FavoritesStackLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: "Favorites", headerShown: false }} />
      <Stack.Screen
        name="track/[id]"
        options={{ headerLargeTitle: false, title: "Track Info" }}
      />
      <Stack.Screen
        name="track/edit"
        options={{ headerLargeTitle: false, title: "Edit Track" }}
      />
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
        name="tidal-artists/[id]"
        options={{ headerLargeTitle: false, title: "" }}
      />
      <Stack.Screen
        name="albums/edit"
        options={{ headerLargeTitle: false, title: "Edit Album" }}
      />
    </Stack>
  );
}
