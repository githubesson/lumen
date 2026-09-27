import { Stack } from "expo-router";
import { stackScreenOptions } from "../../theme/stack-options";

export default function AuthLayout() {
  return (
    <Stack screenOptions={{ ...stackScreenOptions, headerLargeTitle: false }}>
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ title: "Sign in" }} />
      {/* Register draws its own large title; the header only adds the back chevron. */}
      <Stack.Screen name="register" options={{ title: "" }} />
      <Stack.Screen name="reset-password" options={{ headerShown: false }} />
    </Stack>
  );
}
