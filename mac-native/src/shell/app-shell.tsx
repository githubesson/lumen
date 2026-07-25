import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FloatingDock } from '../components/dock/floating-dock';
import { NowPlayingOverlay } from '../components/now-playing/now-playing-overlay';
import { ScreenTransition } from '../components/screen-transition';
import { PlayerProvider } from '../context/player';
import { NavigationProvider, useNavigation } from '../navigation/navigation';
import { OverlayProvider } from './overlay-context';
import { useMenuBindings } from './menu-bindings';
import { useNativeSidebar } from './use-native-sidebar';
import { onToolbarBack, Shell } from '../native/shell';
import { HomeScreen } from '../screens/home';
import { BrowseScreen } from '../screens/browse';
import { FavoritesScreen } from '../screens/favorites';
import { AlbumScreen } from '../screens/album';
import { ArtistScreen } from '../screens/artist';
import { PlaylistsScreen } from '../screens/playlists';
import { PlaylistScreen } from '../screens/playlist';
import { SettingsScreen } from '../screens/settings';

function CurrentScreen({
  onChangeServer,
  searchFocusNonce,
}: {
  onChangeServer: () => void;
  searchFocusNonce: number;
}) {
  const { route } = useNavigation();
  const routeKey =
    'id' in route ? `${route.screen}:${route.id}` : route.screen;

  return (
    <ScreenTransition routeKey={routeKey}>
      <RouteScreen
        onChangeServer={onChangeServer}
        searchFocusNonce={searchFocusNonce}
      />
    </ScreenTransition>
  );
}

function RouteScreen({
  onChangeServer,
  searchFocusNonce,
}: {
  onChangeServer: () => void;
  searchFocusNonce: number;
}) {
  const { route } = useNavigation();
  switch (route.screen) {
    case 'home':
      return <HomeScreen />;
    case 'browse':
      return <BrowseScreen focusNonce={searchFocusNonce} />;
    case 'favorites':
      return <FavoritesScreen />;
    case 'playlists':
      return <PlaylistsScreen />;
    case 'settings':
      return <SettingsScreen onChangeServer={onChangeServer} />;
    case 'album':
      return <AlbumScreen id={route.id} title={route.title} />;
    case 'artist':
      return <ArtistScreen id={route.id} name={route.name} />;
    case 'playlist':
      return <PlaylistScreen id={route.id} name={route.name} />;
  }
}

function ShellBody({ onChangeServer }: { onChangeServer: () => void }) {
  // Bumping a counter is how ⌘F reaches the search field: the field is inside
  // whichever screen is mounted, so there is no stable ref to hand the menu.
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  const requestSearchFocus = useCallback(() => setSearchFocusNonce(n => n + 1), []);

  useMenuBindings(requestSearchFocus);
  // The sidebar is an AppKit source list owned by the window, so React only
  // publishes its contents and handles the selections it reports back.
  useNativeSidebar();

  // Toolbar contents belong to the screen. Reset them on every route change so
  // a screen that wants none inherits nothing from the last one; screens that
  // do want items set them on mount. The back button is navigation state, not
  // screen state, so it is owned here.
  const { route, pop, canGoBack } = useNavigation();
  useEffect(() => {
    if (route.screen !== 'browse') Shell.setToolbar({ showsBack: canGoBack });
  }, [route.screen, canGoBack]);

  useEffect(() => {
    const subscription = onToolbarBack(pop);
    return () => subscription.remove();
  }, [pop]);

  // Deliberately no background: the content pane is painted natively with the
  // sidebar's vibrancy material (`LMContentViewController`), and anything
  // opaque here would cover it and split the window into two surfaces again.
  return (
    <View style={styles.content}>
      <CurrentScreen
        onChangeServer={onChangeServer}
        searchFocusNonce={searchFocusNonce}
      />
      <FloatingDock />
      <NowPlayingOverlay />
    </View>
  );
}

/**
 * Sidebar + content pane, with the player docked over the content only. The
 * dock deliberately does not span the window: a full-width transport bar would
 * cut the sidebar off at the bottom, which no Mac app does.
 */
export function AppShell({ onChangeServer }: { onChangeServer: () => void }) {
  return (
    <PlayerProvider>
      <NavigationProvider>
        <OverlayProvider>
          <ShellBody onChangeServer={onChangeServer} />
        </OverlayProvider>
      </NavigationProvider>
    </PlayerProvider>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1 },
});
