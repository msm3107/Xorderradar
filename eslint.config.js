// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default defineConfig(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      eqeqeq: ["error", "always"],
      // Diagnostics go through the logger (JSON-lines on stderr), never console.*,
      // so stdout stays reserved for command output. The logger does not redact:
      // keeping secrets out of log fields is the caller's job (docs/SECURITY.md).
      "no-console": "error",
    },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
