import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("../plugins/withCarPlay.js") as {
  transformAppDelegate(contents: string): string;
  applyCarPlayInfoPlist(
    infoPlist: Record<string, unknown>,
  ): Record<string, any>;
  applyCarPlayPodfileProperties(
    properties: Record<string, unknown>,
  ): Record<string, unknown>;
  constants: {
    CARPLAY_ROLE: string;
    PHONE_ROLE: string;
    DEV_CLIENT_DEFAULT_URL_KEY: string;
    DEV_LAUNCH_URL_BUILD_SETTING: string;
    BUILD_REACT_NATIVE_FROM_SOURCE_KEY: string;
  };
};

const fixturePath = fileURLToPath(
  new URL("./fixtures/AppDelegate.expo-sdk-57.swift", import.meta.url),
);
const expoAppDelegate = readFileSync(fixturePath, "utf8");

describe("withCarPlay AppDelegate transform", () => {
  it("creates one retained, scene-independent Expo runtime host", () => {
    const transformed = plugin.transformAppDelegate(expoAppDelegate);

    expect(transformed).toContain("internal import LumenCarPlay");
    expect(transformed).toContain(
      "class AppDelegate: ExpoAppDelegate, LumenReactRuntimeHosting",
    );
    expect(transformed).toContain("private var reactRootViewController");
    expect(transformed).toContain("guard !reactRuntimeStarted else { return }");
    expect(transformed).toContain("in: nil");
    expect(transformed).toContain("rootView.frame = UIScreen.main.bounds");
    expect(transformed).toContain('NSSelectorFromString("synchronouslyWaitFor:")');
    expect(transformed).toContain("surfaceProtocol.stage.rawValue & 8");
    expect(transformed).toContain("UIWindow(windowScene: windowScene)");
    expect(transformed).not.toContain("UIWindow(frame:");
    expect(transformed).toContain(
      "let controller = super.createRootViewController()",
    );
    expect(transformed).toContain("override func bundleURL() -> URL?");
    expect(transformed).toContain("RCTLinkingManager.application");
    expect(
      transformed.match(/ExpoReactNativeFactory\(delegate:/g),
    ).toHaveLength(1);
  });

  it("writes complete generated markers and is idempotent", () => {
    const transformed = plugin.transformAppDelegate(expoAppDelegate);

    expect(transformed).toContain(
      "// @generated begin withCarPlay runtime state",
    );
    expect(transformed).toContain(
      "// @generated end withCarPlay runtime launch",
    );
    expect(transformed).toContain(
      "// @generated end withCarPlay runtime host delegate hook",
    );
    expect(plugin.transformAppDelegate(transformed)).toBe(transformed);
  });

  it("fails clearly when Expo's template is unknown", () => {
    const unknown = expoAppDelegate.replace(
      "factory.startReactNative(",
      "factory.launchReactNative(",
    );

    expect(() => plugin.transformAppDelegate(unknown)).toThrow(
      /could not recognize Expo's React startup block.*template may have changed/i,
    );
  });

  it("rejects partial generated output instead of compounding it", () => {
    expect(() =>
      plugin.transformAppDelegate(
        `${expoAppDelegate}\n// @generated begin withCarPlay runtime host`,
      ),
    ).toThrow(/incomplete generated runtime-host block/i);
  });
});

describe("withCarPlay Podfile properties", () => {
  it("builds React Native from source so CarPlay scene safety patches are compiled", () => {
    const { BUILD_REACT_NATIVE_FROM_SOURCE_KEY } = plugin.constants;
    const result = plugin.applyCarPlayPodfileProperties({
      "ios.deploymentTarget": "16.4",
      [BUILD_REACT_NATIVE_FROM_SOURCE_KEY]: "false",
    });

    expect(result).toEqual({
      "ios.deploymentTarget": "16.4",
      [BUILD_REACT_NATIVE_FROM_SOURCE_KEY]: "true",
    });
  });
});

describe("withCarPlay scene manifest", () => {
  it("preserves unrelated scenes and emits exactly one Lumen scene per role", () => {
    const { CARPLAY_ROLE, PHONE_ROLE } = plugin.constants;
    const existingCarScene = {
      UISceneConfigurationName: "Another-CarPlay-Configuration",
    };
    const existingPhoneScene = {
      UISceneConfigurationName: "Another-Phone-Configuration",
    };
    const original = {
      UIApplicationSceneManifest: {
        UISceneConfigurations: {
          [CARPLAY_ROLE]: [existingCarScene],
          [PHONE_ROLE]: [existingPhoneScene],
          OtherRole: [{ UISceneConfigurationName: "Keep-Me" }],
        },
      },
    };

    const once = plugin.applyCarPlayInfoPlist(original);
    const twice = plugin.applyCarPlayInfoPlist(once);
    const manifest = twice.UIApplicationSceneManifest;
    const configurations = manifest.UISceneConfigurations;

    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(true);
    expect(configurations.OtherRole).toEqual([
      { UISceneConfigurationName: "Keep-Me" },
    ]);
    expect(configurations[CARPLAY_ROLE]).toEqual([
      existingCarScene,
      {
        UISceneClassName: "CPTemplateApplicationScene",
        UISceneConfigurationName: "Lumen-CarPlay",
        UISceneDelegateClassName: "LumenCarPlaySceneDelegate",
      },
    ]);
    expect(configurations[PHONE_ROLE]).toEqual([
      existingPhoneScene,
      {
        UISceneClassName: "UIWindowScene",
        UISceneConfigurationName: "Lumen-Phone",
        UISceneDelegateClassName: "LumenPhoneSceneDelegate",
      },
    ]);
  });

  it("injects the optional build variable as Expo Dev Client's default URL", () => {
    const { DEV_CLIENT_DEFAULT_URL_KEY, DEV_LAUNCH_URL_BUILD_SETTING } =
      plugin.constants;

    expect(plugin.applyCarPlayInfoPlist({})[DEV_CLIENT_DEFAULT_URL_KEY]).toBe(
      DEV_LAUNCH_URL_BUILD_SETTING,
    );
    expect(
      plugin.applyCarPlayInfoPlist({
        [DEV_CLIENT_DEFAULT_URL_KEY]: "http://metro.example:8081",
      })[DEV_CLIENT_DEFAULT_URL_KEY],
    ).toBe("http://metro.example:8081");
  });
});
