import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["node_modules", "dist"] },
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
    files: ["tests/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node } },
  },
);
