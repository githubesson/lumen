import { Stack } from "expo-router";
import { stackScreenOptions } from "../../../theme/stack-options";

export default function FavoritesStackLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: "Favorites" }} />
    </Stack>
  );
}
