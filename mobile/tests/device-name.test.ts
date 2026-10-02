import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "ios", isPad: false }));
vi.mock("react-native", () => ({ Platform: platform }));

async function load(os: string, isPad = false) {
  platform.OS = os;
  platform.isPad = isPad;
  vi.resetModules();
  const { LOCAL_DEVICE_NAME, LOCAL_DEVICE_LABEL } = await import("../lib/device-name");
  return { LOCAL_DEVICE_NAME, LOCAL_DEVICE_LABEL };
}

afterEach(() => {
  vi.resetModules();
});

describe("local device name and label", () => {
  it("names an iPhone and an iPad after themselves", async () => {
    expect(await load("ios")).toEqual({
      LOCAL_DEVICE_NAME: "iPhone",
      LOCAL_DEVICE_LABEL: "This iPhone",
    });
    expect(await load("ios", true)).toEqual({
      LOCAL_DEVICE_NAME: "iPad",
      LOCAL_DEVICE_LABEL: "This iPad",
    });
  });

  it("does not call an Android phone an iPhone", async () => {
    expect(await load("android")).toEqual({
      LOCAL_DEVICE_NAME: "Mobile",
      LOCAL_DEVICE_LABEL: "This device",
    });
  });
});
