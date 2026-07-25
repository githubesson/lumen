import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthProvider, FavoritesProvider, useAuth } from '@music-library/core';
import { ThemeProvider, useTheme } from './theme/theme';
import { asyncStorageAdapter } from './adapters/async-storage-adapter';
import { QUERY_STALE_TIME } from './lib/query-policy';
import { applyServerUrl, clearServerUrl, loadServerUrl } from './bootstrap/server-url';
import { Spinner } from './components/primitives';
import { LoginScreen } from './screens/auth/login';
import { RegisterScreen } from './screens/auth/register';
import { ResetPasswordScreen } from './screens/auth/reset-password';
import { ServerSetupScreen } from './screens/auth/server-setup';
import { AppShell } from './shell/app-shell';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_STALE_TIME.default,
      retry: 1,
      // Desktop windows sit open for hours; refetching a whole library view on
      // every window focus is wasteful when staleTime already covers freshness.
      refetchOnWindowFocus: false,
    },
  },
});

const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'mlib-query-cache',
});

/** Splash shown while the persisted server URL and session are being read. */
function Loading() {
  const t = useTheme();
  return (
    <View style={[styles.fill, { backgroundColor: t.color.bg }]}>
      <Spinner />
    </View>
  );
}

type GuestRoute = 'login' | 'register';

function AuthGate({ onChangeServer }: { onChangeServer: () => void }) {
  const { status, me } = useAuth();
  const [route, setRoute] = useState<GuestRoute>('login');

  if (status === 'loading') return <Loading />;

  if (status === 'guest') {
    return route === 'register' ? (
      <RegisterScreen onBack={() => setRoute('login')} />
    ) : (
      <LoginScreen
        onRegister={() => setRoute('register')}
        onChangeServer={onChangeServer}
      />
    );
  }

  if (me?.must_reset_password) return <ResetPasswordScreen />;

  return <AppShell onChangeServer={onChangeServer} />;
}

/**
 * Everything below here needs `setBaseUrl` to have run, so the query client and
 * auth provider are mounted only once a server URL is known.
 */
function ConnectedApp({ onChangeServer }: { onChangeServer: () => void }) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        // Bumping this string discards caches whose shape this build no longer
        // understands, instead of rendering stale data against new code.
        buster: 'lumen-mac-v1',
      }}>
      <AuthProvider sessionCache={asyncStorageAdapter}>
        <FavoritesProvider>
          <AuthGate onChangeServer={onChangeServer} />
        </FavoritesProvider>
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}

function Root() {
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadServerUrl().then(url => {
      if (cancelled) return;
      if (url) applyServerUrl(url);
      setServerUrl(url);
      setResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onConnected = useCallback((url: string) => {
    applyServerUrl(url);
    setServerUrl(url);
  }, []);

  const onChangeServer = useCallback(() => {
    void clearServerUrl();
    // Dropping cached query data too: it belongs to the server being left.
    queryClient.clear();
    setServerUrl(null);
  }, []);

  if (!resolved) return <Loading />;
  if (!serverUrl) return <ServerSetupScreen onConnected={onConnected} />;

  // Remounting on server change tears down auth and query state that belonged
  // to the previous server rather than letting it leak into the new session.
  return <ConnectedApp key={serverUrl} onChangeServer={onChangeServer} />;
}

export default function App() {
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
