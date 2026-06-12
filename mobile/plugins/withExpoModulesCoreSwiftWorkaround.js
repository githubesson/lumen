const { createRunOncePlugin, withPodfile } = require("@expo/config-plugins");

const PLUGIN_NAME = "withExpoModulesCoreSwiftWorkaround";
const PLUGIN_VERSION = "1.0.0";

const WORKAROUND_COMMENT =
  "# Work around Xcode 26 Swift compiler crash in ExpoModulesCore";

const WORKAROUND_SNIPPET = `    ${WORKAROUND_COMMENT}
    installer.pods_project.targets.each do |target|
      next unless target.name == 'ExpoModulesCore'

      target.build_configurations.each do |build_config|
        build_config.build_settings['SWIFT_VERSION'] = '5.10'
        build_config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'
        build_config.build_settings['SWIFT_COMPILATION_MODE'] = 'singlefile'
      end
    end`;

function addExpoModulesCoreSwiftWorkaround(contents) {
  if (contents.includes(WORKAROUND_COMMENT)) {
    return contents;
  }

  const reactNativePostInstallPattern =
    /(react_native_post_install\([\s\S]*?\n\s*\))/m;

  if (!reactNativePostInstallPattern.test(contents)) {
    throw new Error(
      "Cannot add ExpoModulesCore Swift workaround because ios/Podfile format was not recognized."
    );
  }

  return contents.replace(
    reactNativePostInstallPattern,
    `$1\n\n${WORKAROUND_SNIPPET}`
  );
}

const withExpoModulesCoreSwiftWorkaround = config =>
  withPodfile(config, config => {
    config.modResults.contents = addExpoModulesCoreSwiftWorkaround(
      config.modResults.contents
    );
    return config;
  });

module.exports = createRunOncePlugin(
  withExpoModulesCoreSwiftWorkaround,
  PLUGIN_NAME,
  PLUGIN_VERSION
);
