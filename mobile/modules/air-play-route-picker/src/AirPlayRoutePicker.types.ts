import type { ColorValue, ViewProps } from "react-native";

export type AirPlayRoutePickerViewProps = ViewProps & {
  tintColor?: ColorValue;
  activeTintColor?: ColorValue;
  prioritizesVideoDevices?: boolean;
};
