import { Redirect } from "expo-router";

/**
 * The app has no dedicated home screen — the desktop "Home" route was a
 * placeholder. On mobile we land users straight on the Library tab.
 */
export default function Index() {
  return <Redirect href="/(tabs)/(library)" />;
}
