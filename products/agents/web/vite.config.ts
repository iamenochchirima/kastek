import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: { port: 3100, strictPort: true, watch: { ignored: ["**/.artifacts/**"] }, proxy: {
      "/api": { target: env.AGENTS_API_PROXY_TARGET || "http://127.0.0.1:4100", changeOrigin: true },
    } },
    preview: { port: 3100, strictPort: true, proxy: { "/api": { target: env.AGENTS_API_PROXY_TARGET || "http://127.0.0.1:4100", changeOrigin: true } } },
  };
});
