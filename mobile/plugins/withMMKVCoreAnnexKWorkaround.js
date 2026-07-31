const { createRunOncePlugin, withPodfile } = require("@expo/config-plugins");

const PLUGIN_NAME = "withMMKVCoreAnnexKWorkaround";
const PLUGIN_VERSION = "1.0.0";

const WORKAROUND_COMMENT =
  "# Work around MMKVCore failing to see memset_s() (C11 Annex K)";

// MMKV 2.4.1 added a secure_wipe() helper that calls memset_s() on Apple
// platforms. Apple only declares memset_s() when __STDC_WANT_LIB_EXT1__ is set
// before <string.h> is first read, and MMKVCore's own #define lands too late:
// CocoaPods force-includes a prefix header that imports UIKit — and therefore
// <string.h> — ahead of every source file in the pod. Defining it as a build
// setting puts it on the compiler command line, which is processed before any
// header. MMKV is pulled in unpinned by react-native-background-downloader
// ("MMKV >= 1.2.0"), so this cannot be dodged by staying on 2.4.0.
const WORKAROUND_SNIPPET = `    ${WORKAROUND_COMMENT}
    installer.pods_project.targets.each do |target|
      next unless target.name == 'MMKVCore'

      target.build_configurations.each do |build_config|
        defines = build_config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] || '$(inherited)'
        defines = defines.join(' ') if defines.is_a?(Array)
        next if defines.include?('__STDC_WANT_LIB_EXT1__')

        build_config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] = "#{defines} __STDC_WANT_LIB_EXT1__=1"
      end
    end`;

function addMMKVCoreAnnexKWorkaround(contents) {
  if (contents.includes(WORKAROUND_COMMENT)) {
    return contents;
  }

  const reactNativePostInstallPattern =
    /(react_native_post_install\([\s\S]*?\n\s*\))/m;

  if (!reactNativePostInstallPattern.test(contents)) {
    throw new Error(
      "Cannot add MMKVCore Annex K workaround because ios/Podfile format was not recognized."
    );
  }

  return contents.replace(
    reactNativePostInstallPattern,
    `$1\n\n${WORKAROUND_SNIPPET}`
  );
}

const withMMKVCoreAnnexKWorkaround = config =>
  withPodfile(config, config => {
    config.modResults.contents = addMMKVCoreAnnexKWorkaround(
      config.modResults.contents
    );
    return config;
  });

module.exports = createRunOncePlugin(
  withMMKVCoreAnnexKWorkaround,
  PLUGIN_NAME,
  PLUGIN_VERSION
);
