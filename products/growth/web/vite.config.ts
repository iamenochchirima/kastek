import { defineConfig, loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { reactRouter } from "@react-router/dev/vite";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [reactRouter(), tsconfigPaths()],
    server: {
      port: 3000, host: "0.0.0.0", allowedHosts: ["dev-client.kasitek.co.za"],
      proxy: { "/api": { target: process.env.CORE_API_BASE_URL || env.CORE_API_BASE_URL || "http://localhost:4000", changeOrigin: false } },
    },
    build: { sourcemap: false },
  };
});
