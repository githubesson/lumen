import { Stack } from "expo-router";
import { stackScreenOptions } from "../../../theme/stack-options";

/**
 * Shared stack behind two tabs. The Library tab anchors on the home page and
 * the Browse tab anchors on the browse list; both carry the same detail
 * screens (albums, artists, tracks, upload) so a tap inside either tab pushes
 * locally instead of hopping to the other tab. Hrefs inside this group omit
 * the group segment for that reason — the router resolves them into whichever
 * tab is current.
 */
const ANCHORS = {
  library: "index",
  browse: "browse",
} as const;

// Deep links and href matching read this; the navigator itself reads the
// `initialRouteName` prop below, because with screens listed explicitly the
// anchor no longer drives their order.
export const unstable_settings = {
  library: { anchor: ANCHORS.library },
  browse: { anchor: ANCHORS.browse },
};

export default function LibraryStackLayout({ segment }: { segment: string }) {
  const group = segment.match(/\((.*)\)/)?.[1];
  const initialRouteName =
    group === "browse" ? ANCHORS.browse : ANCHORS.library;
  return (
    <Stack screenOptions={stackScreenOptions} initialRouteName={initialRouteName}>
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
