import { defineConfig, globalIgnores } from "eslint/config";
import { default as nextVitals } from "eslint-config-next/core-web-vitals";
import { default as nextTs } from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
