import { requireOptionalNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

import type {
  LockScreenCommandEvent,
  LockScreenControlsModule,
} from "./LockScreenControls.types";

const nativeModule =
  requireOptionalNativeModule<LockScreenControlsModule>("LockScreenControls");

const noopSubscription: EventSubscription = {
  remove() {},
};

export function isLockScreenControlsAvailable() {
  return nativeModule != null;
}

export function setLockScreenTrackControlsEnabled(enabled: boolean) {
  nativeModule?.setEnabled(enabled);
}

export function addLockScreenCommandListener(
  listener: (event: LockScreenCommandEvent) => void,
) {
  return nativeModule?.addListener("onCommand", listener) ?? noopSubscription;
}
