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
    // SafeHttpClientDeps (transport, resolver, clock, sleep, …) are test-only
    // seams: passing them can bypass address pinning, the SSRF check and rate
    // limiting. Production code constructs the client with options only. This
    // catches the direct, namespace-import and renamed-import forms; other
    // indirection (`const C = SafeHttpClient`, `Reflect.construct`) is left to
    // code review. Pinned by tests/http-client-lint-guard.test.ts.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "NewExpression:matches([callee.name='SafeHttpClient'], [callee.property.name='SafeHttpClient'])[arguments.length>1]",
          message:
            "SafeHttpClientDeps are test-only (they can bypass SSRF protection and rate limiting); use new SafeHttpClient(options).",
        },
        {
          selector:
            "NewExpression:matches([callee.name='SafeHttpClient'], [callee.property.name='SafeHttpClient']) > SpreadElement",
          message:
            "Pass SafeHttpClient options explicitly; spread arguments could smuggle in test-only deps.",
        },
        {
          selector:
            ":matches(ClassDeclaration, ClassExpression):matches([superClass.name='SafeHttpClient'], [superClass.property.name='SafeHttpClient'])",
          message:
            "Do not subclass SafeHttpClient; a subclass could pass test-only deps to super().",
        },
        {
          selector: "ImportSpecifier[imported.name='SafeHttpClient'][local.name!='SafeHttpClient']",
          message:
            "Import SafeHttpClient under its own name so the lint guard on its constructor applies.",
        },
      ],
    },
  },
  {
    // Matching is pure (D-023): it may import its own modules, the domain and
    // the pure normalization helpers in src/sources/normalize/ — nothing else
    // (no infrastructure, no source adapters, no Node built-ins, no packages).
    // An allowlist of one-segment relative paths, so "../sources/normalize/../x"
    // does not pass. Dynamic import() is left to code review. Pinned by
    // tests/matching-dependency-guard.test.ts.
    files: ["src/matching/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!(?:\\./[\\w-]+|\\.\\./domain/[\\w-]+|\\.\\./sources/normalize/[\\w-]+)\\.js$)",
              message:
                "src/matching may import only ./*, ../domain/* and ../sources/normalize/* (D-023).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
