import { ActionSheetIOS, Alert, Platform } from "react-native";

export interface ActionMenuItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/**
 * A native action sheet on iOS, and an Alert with the same choices elsewhere.
 * A "Cancel" entry is added; disabled items show greyed out on iOS and are
 * left out of the Alert, which has no disabled state.
 */
export function showActionMenu({
  title,
  message,
  items,
  tintColor,
  userInterfaceStyle,
  anchor,
}: {
  title?: string;
  message?: string;
  items: ActionMenuItem[];
  tintColor?: string;
  userInterfaceStyle?: "light" | "dark";
  /** iPad popover source (a native node handle). */
  anchor?: number;
}): void {
  if (Platform.OS !== "ios") {
    Alert.alert(title ?? "", message, [
      ...items
        .filter((item) => !item.disabled)
        .map((item) => ({
          text: item.label,
          onPress: item.onPress,
          style: item.destructive ? ("destructive" as const) : undefined,
        })),
      { text: "Cancel", style: "cancel" as const },
    ]);
    return;
  }

  const cancelButtonIndex = items.length;
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title,
      message,
      options: [...items.map((item) => item.label), "Cancel"],
      cancelButtonIndex,
      destructiveButtonIndex: indicesWhere(items, (item) => item.destructive),
      disabledButtonIndices: indicesWhere(items, (item) => item.disabled),
      tintColor,
      userInterfaceStyle,
      anchor,
    },
    (selectedIndex) => {
      if (selectedIndex === cancelButtonIndex) return;
      items[selectedIndex]?.onPress();
    },
  );
}

function indicesWhere(
  items: ActionMenuItem[],
  predicate: (item: ActionMenuItem) => boolean | undefined,
): number[] {
  const indices: number[] = [];
  items.forEach((item, index) => {
    if (predicate(item)) indices.push(index);
  });
  return indices;
}
