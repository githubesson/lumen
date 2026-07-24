const {
  createRunOncePlugin,
  withEntitlementsPlist,
  withInfoPlist,
} = require("@expo/config-plugins");

const PLUGIN_NAME = "withCarPlay";
const PLUGIN_VERSION = "1.0.0";

const CARPLAY_ROLE = "CPTemplateApplicationSceneSessionRoleApplication";
const PHONE_ROLE = "UIWindowSceneSessionRoleApplication";
const CARPLAY_CONFIGURATION_NAME = "Lumen-CarPlay";
const PHONE_CONFIGURATION_NAME = "Lumen-Phone";
// Flat Objective-C name, set by @objc on the Swift class. Keep in sync with
// modules/carplay/ios/LumenCarPlaySceneDelegate.swift.
const DELEGATE_CLASS = "LumenCarPlaySceneDelegate";
const PHONE_DELEGATE_CLASS = "LumenPhoneSceneDelegate";
const AUDIO_ENTITLEMENT = "com.apple.developer.carplay-audio";

/**
 * Declares the CarPlay scene so UIKit hands our delegate the interface
 * controller when a head unit (or the simulator's CarPlay display) connects.
 *
 * Declaring any scene role opts the app into UIKit's scene lifecycle. The
 * phone role therefore needs a delegate too: it attaches the window Expo
 * already created in AppDelegate to the UIWindowScene. Without it the process
 * launches, but the phone display remains black and React Native never mounts.
 *
 * The `com.apple.developer.carplay-audio` entitlement is opt-in: Apple grants
 * it per app after review, and an ungranted entitlement breaks device
 * provisioning. The CarPlay simulator doesn't check it, so development works
 * without it. Enable with `["./plugins/withCarPlay", { "audioEntitlement": true }]`
 * once Apple approves.
 */
function withCarPlay(config, { audioEntitlement = false } = {}) {
  config = withInfoPlist(config, (config) => {
    const manifest = config.modResults.UIApplicationSceneManifest ?? {};
    const configurations = manifest.UISceneConfigurations ?? {};

    const existing = Array.isArray(configurations[CARPLAY_ROLE])
      ? configurations[CARPLAY_ROLE].filter(
          (entry) =>
            entry.UISceneConfigurationName !== CARPLAY_CONFIGURATION_NAME,
        )
      : [];
    const existingPhone = Array.isArray(configurations[PHONE_ROLE])
      ? configurations[PHONE_ROLE].filter(
          (entry) =>
            entry.UISceneConfigurationName !== PHONE_CONFIGURATION_NAME,
        )
      : [];

    config.modResults.UIApplicationSceneManifest = {
      ...manifest,
      // Two scenes are live at once whenever CarPlay is connected.
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {
        ...configurations,
        [PHONE_ROLE]: [
          ...existingPhone,
          {
            UISceneClassName: "UIWindowScene",
            UISceneConfigurationName: PHONE_CONFIGURATION_NAME,
            UISceneDelegateClassName: PHONE_DELEGATE_CLASS,
          },
        ],
        [CARPLAY_ROLE]: [
          ...existing,
          {
            UISceneClassName: "CPTemplateApplicationScene",
            UISceneConfigurationName: CARPLAY_CONFIGURATION_NAME,
            UISceneDelegateClassName: DELEGATE_CLASS,
          },
        ],
      },
    };

    return config;
  });

  if (audioEntitlement) {
    config = withEntitlementsPlist(config, (config) => {
      config.modResults[AUDIO_ENTITLEMENT] = true;
      return config;
    });
  }

  return config;
}

module.exports = createRunOncePlugin(withCarPlay, PLUGIN_NAME, PLUGIN_VERSION);
