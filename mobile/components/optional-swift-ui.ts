import type { ComponentType, ReactNode } from "react";
import { requireOptionalNativeModule } from "expo-modules-core";

declare const require: (id: string) => unknown;

type SwiftContextMenu = ComponentType<{ children: ReactNode }> & {
  Items: ComponentType<{ children: ReactNode }>;
  Trigger: ComponentType<{ children: ReactNode }>;
  Preview: ComponentType<{ children: ReactNode }>;
};

export type SwiftUIComponents = {
  Button: ComponentType<any>;
  ControlGroup: ComponentType<any>;
  ContextMenu: SwiftContextMenu;
  Divider: ComponentType<any>;
  Host: ComponentType<any>;
  Menu: ComponentType<any>;
  RNHostView: ComponentType<any>;
  Section: ComponentType<any>;
};

let cachedSwiftUI: SwiftUIComponents | null | undefined;

export function getOptionalSwiftUI(): SwiftUIComponents | null {
  if (cachedSwiftUI !== undefined) return cachedSwiftUI;

  if (!requireOptionalNativeModule("ExpoUI")) {
    cachedSwiftUI = null;
    return cachedSwiftUI;
  }

  try {
    const swiftUI = require("@expo/ui/swift-ui") as SwiftUIComponents;
    cachedSwiftUI = {
      Button: swiftUI.Button,
      ControlGroup: swiftUI.ControlGroup,
      ContextMenu: swiftUI.ContextMenu,
      Divider: swiftUI.Divider,
      Host: swiftUI.Host,
      Menu: swiftUI.Menu,
      RNHostView: swiftUI.RNHostView,
      Section: swiftUI.Section,
    };
  } catch (error) {
    console.warn(
      `ExpoUI is not available in this iOS binary. Rebuild the native app to enable Liquid Glass menus. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    cachedSwiftUI = null;
  }

  return cachedSwiftUI;
}

const modifier = (type: string, params: Record<string, unknown> = {}) => ({
  $type: type,
  ...params,
});

export const swiftAccessibilityLabel = (label: string) =>
  modifier("accessibilityLabel", { label });

export const swiftButtonStyle = (
  style: "automatic" | "bordered" | "borderedProminent" | "borderless" | "glass" | "glassProminent" | "plain",
) => modifier("buttonStyle", { style });

export const swiftControlSize = (
  size: "mini" | "small" | "regular" | "large" | "extraLarge",
) => modifier("controlSize", { size });

export const swiftDisabled = (disabled = true) =>
  modifier("disabled", { disabled });

export const swiftFrame = (params: {
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}) => modifier("frame", params);

export const swiftLabelStyle = (
  style: "automatic" | "iconOnly" | "titleAndIcon" | "titleOnly",
) => modifier("labelStyle", { style });
