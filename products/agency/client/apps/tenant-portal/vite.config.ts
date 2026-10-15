import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxy: Record<string, ProxyOptions> = {
    "/api/tenant": {
      target: env.TENANT_BACKEND_URL || "http://127.0.0.1:8090",
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/tenant(?=\/|\?|$)/, "") || "/",
      configure(proxy) {
        proxy.on("proxyReq", (proxyReq, req) => {
          if (req.headers.host) {
            proxyReq.setHeader("x-kasitek-tenant-host", req.headers.host);
            proxyReq.setHeader("x-forwarded-host", req.headers.host);
          }
          proxyReq.setHeader("x-forwarded-proto", "http");
        });
      },
    },
  };
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: { host: "127.0.0.1", port: 3010, strictPort: true, proxy },
    preview: { host: "127.0.0.1", port: 3010, strictPort: true, proxy },
  };
});
