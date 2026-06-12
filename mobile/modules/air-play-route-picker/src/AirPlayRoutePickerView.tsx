import { requireNativeView } from "expo";
import * as React from "react";

import type { AirPlayRoutePickerViewProps } from "./AirPlayRoutePicker.types";

let NativeView: React.ComponentType<AirPlayRoutePickerViewProps> | null = null;

try {
  NativeView = requireNativeView<AirPlayRoutePickerViewProps>("AirPlayRoutePicker");
} catch {
  NativeView = null;
}

export function isAirPlayRoutePickerAvailable() {
  return NativeView != null;
}

export function AirPlayRoutePickerView(props: AirPlayRoutePickerViewProps) {
  if (!NativeView) return null;

  return <NativeView {...props} />;
}
