const {
  createRunOncePlugin,
  withInfoPlist,
} = require("@expo/config-plugins");

const PLUGIN_NAME = "withInstagramStorySharing";
const PLUGIN_VERSION = "1.0.0";
const INSTAGRAM_STORIES_SCHEME = "instagram-stories";

function ensureUnique(items, value) {
  return items.includes(value) ? items : [...items, value];
}

function withInstagramStorySharing(config) {
  return withInfoPlist(config, (config) => {
    const schemes = Array.isArray(
      config.modResults.LSApplicationQueriesSchemes,
    )
      ? config.modResults.LSApplicationQueriesSchemes
      : [];

    config.modResults.LSApplicationQueriesSchemes = ensureUnique(
      schemes,
      INSTAGRAM_STORIES_SCHEME,
    );
    return config;
  });
}

module.exports = createRunOncePlugin(
  withInstagramStorySharing,
  PLUGIN_NAME,
  PLUGIN_VERSION,
);
