import type { EventSubscription } from "expo-modules-core";

export type LockScreenCommand = "next" | "previous";

export type LockScreenCommandEvent = {
  action: LockScreenCommand;
};

export type LockScreenControlsModule = {
  setEnabled(enabled: boolean): void;
  addListener(
    eventName: "onCommand",
    listener: (event: LockScreenCommandEvent) => void,
  ): EventSubscription;
};
