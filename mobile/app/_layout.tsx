import { useEffect, useRef, type ReactNode } from "react";
import {
  ActivityIndicator,
  AppState,
  View,
  useColorScheme,
} from "react-native";
import Constants from "expo-constants";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import NetInfo from "@react-native-community/netinfo";
import {
  ThemeProvider as NavThemeProvider,
  DarkTheme as NavDarkTheme,
  DefaultTheme as NavDefaultTheme,
} from "@react-navigation/native";
import {
  AuthProvider,
  FavoritesProvider,
  libraryChanged,
  setBaseUrl,
  useAuth,
} from "@music-library/core";
import { PlayerProvider } from "../context/player";
import { ThemeProvider, useTheme } from "../theme/theme";
import { invalidateLibrary } from "../lib/query-keys";

// Resolve the backend base URL. Prefer a build-time env var (EXPO_PUBLIC_...)
// for flexibility across dev / staging / prod; fall back to app.json `extra`.
const apiBaseUrl =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)
    ?.apiBaseUrl ??
  "";

// Point the shared API client at our backend before any React code fires
// `api.me()`. Module side-effect is safe: imports resolve synchronously.
setBaseUrl(apiBaseUrl);

// React Query: one client for the app. Sensible defaults for a mobile
// streaming app — short stale-time, retry once, pause while offline.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnReconnect: true,
    },
  },
});

// Wire React Query to NetInfo so queries pause cleanly while offline instead
// of spamming retries.
onlineManager.setEventListener((setOnline) => {
  return NetInfo.addEventListener((state) => {
    setOnline(!!state.isConnected);
  });
});

/**
 * Root layout. Composes every provider the tree needs and renders a small
 * auth gate that redirects between (auth) and (tabs) based on session.
 *
 * Note on cookies: we rely on the platform's native cookie jar
 * (NSHTTPCookieStorage on iOS) which `fetch()` uses automatically. No
 * explicit cookie library is needed for MVP — that would require a native
 * module that's not available in Expo Go. If we later need programmatic
 * cookie control (e.g. to purge on sign-out), it can live behind a dev
 * client build.
 */
export default function RootLayout() {
  // @react-navigation/native ThemeProvider prevents header-button flicker
  // when the tab navigator swaps stacks.
  const colorScheme = useColorScheme();
  const navTheme = colorScheme === "dark" ? NavDarkTheme : NavDefaultTheme;

  useEffect(() => {
    focusManager.setFocused(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", (status) => {
      focusManager.setFocused(status === "active");
    });
    return () => {
      subscription.remove();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <NavThemeProvider value={navTheme}>
          <ThemeProvider>
            <AuthProvider>
              <AccountScopedProviders>
                <AuthGate />
                <ThemedStatusBar />
              </AccountScopedProviders>
            </AuthProvider>
          </ThemeProvider>
        </NavThemeProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

function AccountScopedProviders({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const accountKey = status === "authed" ? me?.id ?? "authed" : status;
  const previousAccountKey = useRef<string | null>(null);

  useEffect(() => {
    if (status === "loading") return;
    if (previousAccountKey.current === null) {
      previousAccountKey.current = accountKey;
      return;
    }
    if (previousAccountKey.current !== accountKey) {
      queryClient.clear();
      previousAccountKey.current = accountKey;
    }
  }, [accountKey, status]);

  // The library event bus is the single signal that library content changed
  // (upload, delete, metadata edit, admin rescan). One subscriber here turns
  // every emit into a cache invalidation so the browse lists, detail screens,
  // favorites, recent and playlists all refresh. Without it the emits were
  // no-ops, which left deleted tracks and post-rescan changes stale on screen.
  // `queryClient` is a module-scoped singleton, so an empty dep array is right.
  useEffect(() => libraryChanged.on(() => invalidateLibrary(queryClient)), []);

  return (
    <FavoritesProvider key={`favorites:${accountKey}`}>
      <PlayerProvider key={`player:${accountKey}`}>{children}</PlayerProvider>
    </FavoritesProvider>
  );
}

/**
 * Redirects between the (auth) and (tabs) route groups based on session. Root
 * stack renders (auth), (tabs), and now-playing (as a modal); this gate just
 * observes session status and replaces the route when it changes.
 */
function AuthGate() {
  const { status, me } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    const routeSegments = Array.from(segments);
    const inAuthGroup = segments[0] === "(auth)";
    const atResetPassword =
      inAuthGroup && routeSegments[1] === "reset-password";

    if (status === "guest" && !inAuthGroup) {
      router.replace("/(auth)/login");
      return;
    }
    if (status === "authed") {
      if (me?.must_reset_password && !atResetPassword) {
        router.replace("/(auth)/reset-password");
        return;
      }
      if (!me?.must_reset_password && inAuthGroup) {
        router.replace("/(tabs)/(library)");
        return;
      }
    }
  }, [status, me, segments, router]);

  if (status === "loading") {
    return <LoadingSplash />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="playlist-picker"
        options={{
          presentation: "modal",
          headerShown: true,
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name="share-track"
        options={{
          presentation: "fullScreenModal",
          gestureEnabled: false,
          headerShown: true,
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name="now-playing"
        options={{
          // Modal (sheet) presentation keeps the tabs screen (and the
          // floating dock) mounted behind it, and the iOS sheet gives
          // native drag-down-to-dismiss for free.
          presentation: "modal",
          gestureEnabled: true,
        }}
      />
    </Stack>
  );
}

function LoadingSplash() {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: theme.color.bg,
      }}
    >
      <ActivityIndicator color={theme.color.fgMuted} />
    </View>
  );
}

function ThemedStatusBar() {
  const theme = useTheme();
  return <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />;
}
