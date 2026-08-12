import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    rules: {
      // These effects hydrate browser-only preferences after SSR. Keep the
      // existing behavior while the admin app is migrated to a shared client
      // state boundary.
      "react-hooks/set-state-in-effect": "off",
      "prefer-const": "warn",
    },
  },
]);
