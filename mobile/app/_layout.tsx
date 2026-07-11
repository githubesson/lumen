import { useEffect, useRef, type ReactNode } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import Constants from "expo-constants";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  focusManager,
  QueryClient,
  onlineManager,
} from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import NetInfo from "@react-native-community/netinfo";
import {
  ThemeProvider as NavThemeProvider,
  DarkTheme as NavDarkTheme,
  DefaultTheme as NavDefaultTheme,
} from "@react-navigation/native";
import {
  AuthProvider,
  libraryChanged,
  setBaseUrl,
  useAuth,
} from "@music-library/core";
import { PlayerProvider } from "../context/player";
import { ThemeProvider, useTheme } from "../theme/theme";
import { invalidateLibrary } from "../lib/query-keys";
import { DownloadsProvider } from "../lib/downloads";
import { RemoteControlIndicator } from "../components/remote-control-indicator";
import {
  fileSystemPersister,
  shouldPersistQuery,
} from "../lib/query-persister";
import { QUERY_STALE_TIME } from "../lib/query-policy";

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

// How long a persisted page cache stays usable offline. Kept generous so the
// app still renders after days without a launch; `gcTime` matches so restored
// queries aren't evicted from memory before `maxAge`. `CACHE_BUSTER` drops the
// whole on-disk cache when the app version changes (schema/shape drift).
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const CACHE_BUSTER = `v2:${Constants.expoConfig?.version ?? "0"}`;

// React Query: one client for the app. Mutations and the library event bus
// invalidate affected keys immediately; the freshness window only prevents
// repeated mount/focus requests for data fetched in the last couple of minutes.
// Offline, `onlineManager` pauses requests and the selective persisted cache is
// what renders. `gcTime` matches the disk cache's maximum age.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_STALE_TIME.default,
      gcTime: CACHE_MAX_AGE,
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
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: fileSystemPersister,
          maxAge: CACHE_MAX_AGE,
          buster: CACHE_BUSTER,
          dehydrateOptions: {
            shouldDehydrateMutation: () => false,
            shouldDehydrateQuery: shouldPersistQuery,
          },
        }}
      >
        <ThemeProvider>
          <ThemedNavigation>
            <DownloadsProvider>
              <AuthProvider>
                <AccountScopedProviders>
                  <AuthGate />
                  <ThemedStatusBar />
                </AccountScopedProviders>
              </AuthProvider>
            </DownloadsProvider>
          </ThemedNavigation>
        </ThemeProvider>
      </PersistQueryClientProvider>
    </GestureHandlerRootView>
  );
}

/** Keep React Navigation's UIKit-owned headers on the app's resolved theme,
 * including a persisted override that differs from the device setting. */
function ThemedNavigation({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const navTheme = theme.scheme === "dark" ? NavDarkTheme : NavDefaultTheme;
  return <NavThemeProvider value={navTheme}>{children}</NavThemeProvider>;
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
      // Drop the on-disk cache too, so a signed-out/switched account can't
      // restore the previous account's pages on the next cold launch.
      void fileSystemPersister.removeClient();
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
    <PlayerProvider key={`player:${accountKey}`}>
      {children}
      <RemoteControlIndicator />
    </PlayerProvider>
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
