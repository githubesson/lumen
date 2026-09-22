import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import { plugin as shadcn } from "@shadcn/lint";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "electron/build", "release"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { shadcn },
    settings: {
      shadcn: {
        // Lumen imports its custom UI through relative component paths.
        componentImports: ["^(?:\\./|(?:\\.\\./)+)components/"],
        note: "See frontend/README.md#design-system-rules for Lumen's styling policy.",
      },
    },
    rules: {
      "shadcn/no-raw-colors": "error",
      "shadcn/no-unknown-classes": "error",
      "shadcn/no-arbitrary-values": ["error", { allow: ["layout"] }],
      "shadcn/require-static-classes": "error",
      "shadcn/no-restyle": [
        "error",
        {
          allow: ["layout"],
          // Existing CSS treatments are allowed only on their owning components.
          contracts: [
            { pattern: "^Button$", allow: ["layout", "artist-hero-back"] },
            {
              pattern: "^CoverArt$",
              allow: ["layout", "card-art", "mini-art", "detail-art", "share-preview-art", "artist-hero-avatar"],
            },
            { pattern: "^WindowControls$", allow: ["layout", "root-window-controls"] },
            { pattern: "^SearchInput$", allow: ["layout", "playlist-search"] },
            { pattern: "^ListPageHeader$", allow: ["layout", "replay-hero"] },
            { pattern: "^LoadingState$", allow: ["layout", "share-preview-status"] },
            { pattern: "^Section$", allow: ["layout", "artist-section"] },
          ],
        },
      ],
      // Inline styles are an established part of Lumen's component API.
      "shadcn/no-inline-styles": "off",
    },
  },
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      // Implementations own appearance and forward dynamic className props.
      "shadcn/no-restyle": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/require-static-classes": "off",
    },
  },
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
      // Resetting local state when a dependency changes legitimately calls
      // setState from an effect; suppress those inline with a reason. Prefer
      // `useApiResource` for plain data loading. (`lint` runs with
      // --max-warnings=0, so a "warn" here would fail CI just the same.)
      "react-hooks/set-state-in-effect": "error",
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
