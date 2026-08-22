import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist/**", ".wrangler/**"]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat["recommended-latest"],
  jsxA11y.flatConfigs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { react: { version: "detect" } },
    rules: {
      eqeqeq: ["error", "always"],
      "jsx-a11y/no-autofocus": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-implicit-coercion": "error",
      "prefer-const": "error",
    },
  },
]);
