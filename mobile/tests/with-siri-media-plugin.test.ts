import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const siriPlugin = require("../plugins/withSiriMedia.js") as {
  transformAppDelegate(contents: string): string;
  applySiriInfoPlist(
    infoPlist: Record<string, unknown>,
    usageDescription?: string,
  ): Record<string, any>;
  applySiriEntitlements(
    entitlements: Record<string, unknown>,
  ): Record<string, unknown>;
};
const carPlayPlugin = require("../plugins/withCarPlay.js") as {
  transformAppDelegate(contents: string): string;
};

const fixturePath = fileURLToPath(
  new URL("./fixtures/AppDelegate.expo-sdk-57.swift", import.meta.url),
);
const expoAppDelegate = readFileSync(fixturePath, "utf8");

describe("withSiriMedia AppDelegate transform", () => {
  it("installs the in-app play-media handler and is idempotent", () => {
    const transformed = siriPlugin.transformAppDelegate(expoAppDelegate);

    expect(transformed).toContain("import Intents");
    expect(transformed).toContain("internal import LumenSiriMedia");
    expect(transformed).toContain("handlerFor intent: INIntent");
    expect(transformed).toContain("LumenPlayMediaIntentHandler.shared");
    expect(siriPlugin.transformAppDelegate(transformed)).toBe(transformed);
  });

  it("composes with the existing CarPlay transform in either order", () => {
    const carThenSiri = siriPlugin.transformAppDelegate(
      carPlayPlugin.transformAppDelegate(expoAppDelegate),
    );
    const siriThenCar = carPlayPlugin.transformAppDelegate(
      siriPlugin.transformAppDelegate(expoAppDelegate),
    );

    for (const transformed of [carThenSiri, siriThenCar]) {
      expect(transformed).toContain("LumenReactRuntimeHosting");
      expect(transformed).toContain("internal import LumenCarPlay");
      expect(transformed).toContain("internal import LumenSiriMedia");
      expect(transformed).toContain("handlerFor intent: INIntent");
    }
  });

  it("rejects incomplete generated output", () => {
    expect(() =>
      siriPlugin.transformAppDelegate(
        `${expoAppDelegate}\n// @generated begin withSiriMedia intent handler`,
      ),
    ).toThrow(/incomplete generated AppDelegate block/i);
  });
});

describe("withSiriMedia configuration", () => {
  it("preserves existing intent configuration and adds music playback", () => {
    const result = siriPlugin.applySiriInfoPlist({
      NSSiriUsageDescription: "Existing explanation",
      INIntentsSupported: ["INAddMediaIntent"],
      INSupportedMediaCategories: ["INMediaCategoryPodcasts"],
    });

    expect(result.NSSiriUsageDescription).toBe("Existing explanation");
    expect(result.INIntentsSupported).toEqual([
      "INAddMediaIntent",
      "INPlayMediaIntent",
    ]);
    expect(result.INSupportedMediaCategories).toEqual([
      "INMediaCategoryPodcasts",
      "INMediaCategoryMusic",
    ]);
  });

  it("adds the Siri code-signing entitlement", () => {
    expect(
      siriPlugin.applySiriEntitlements({ "com.apple.developer.foo": true }),
    ).toEqual({
      "com.apple.developer.foo": true,
      "com.apple.developer.siri": true,
    });
  });
});
