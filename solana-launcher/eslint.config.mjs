import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const nextConfig = [...nextVitals, ...nextTs];
const inheritedPlugins = Object.assign({}, ...nextConfig.map((config) => config.plugins || {}));

export default defineConfig([
  ...nextConfig,
  {
    plugins: inheritedPlugins,
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "warn",
      "react/no-unescaped-entities": "warn",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/static-components": "off",
    },
  },
  {
    files: ["**/*.cjs", "tests/**/*.js"],
    plugins: inheritedPlugins,
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "test-results/**",
    "data/**",
    "solana-wallet-warmup/**",
    "tmp-check-dups.cjs",
  ]),
]);
