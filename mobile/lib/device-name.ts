import { Platform } from "react-native";

/** The name this app publishes to the playback session for other devices to see. */
export const LOCAL_DEVICE_NAME =
  Platform.OS === "ios" ? (Platform.isPad ? "iPad" : "iPhone") : "Mobile";

/** How the device picker names this device ("This iPhone", "This iPad"). */
export const LOCAL_DEVICE_LABEL =
  Platform.OS === "ios" ? `This ${LOCAL_DEVICE_NAME}` : "This device";

/** The same, mid-sentence ("3.1 GB on this iPhone"). */
export const LOCAL_DEVICE_PHRASE =
  Platform.OS === "ios" ? `this ${LOCAL_DEVICE_NAME}` : "this device";
