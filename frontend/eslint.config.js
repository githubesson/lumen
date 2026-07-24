import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "electron/build", "release"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2021 },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Mount-time data loading (`void refresh()`) legitimately kicks off a
      // setState from an effect. Kept visible as a warning rather than an
      // error so the rule still surfaces new occurrences.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // Electron main/preload and build scripts are Node, not browser, and
    // contain no React.
    files: ["electron/**/*.ts", "scripts/**/*.{mjs,cjs,js}", "*.config.{js,ts}"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
