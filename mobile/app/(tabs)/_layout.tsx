import { Tabs } from "expo-router";
import { DockProvider } from "../../components/dock/dock-context";
import { BottomDock } from "../../components/dock/bottom-dock";

/**
 * Four-tab root with a fully custom floating dock instead of the native tab
 * bar: an Instagram-style pill tab bar plus the mini-player (stacked above it
 * on iPhone, beside it on iPad). `DockProvider` wraps the navigator so the
 * dock and the screens (scroll wiring) share the collapse state. Nested
 * stacks own their headers, so the tab navigator's are off.
 */
export default function TabsLayout() {
  return (
    <DockProvider>
      <Tabs
        tabBar={(props) => <BottomDock {...props} />}
        screenOptions={{ headerShown: false }}
      >
        <Tabs.Screen name="(library)" options={{ title: "Library" }} />
        <Tabs.Screen name="(playlists)" options={{ title: "Playlists" }} />
        <Tabs.Screen name="(favorites)" options={{ title: "Favorites" }} />
        <Tabs.Screen name="(settings)" options={{ title: "Settings" }} />
      </Tabs>
    </DockProvider>
  );
}
