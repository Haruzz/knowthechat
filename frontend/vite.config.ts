import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backendOrigin =
  process.env.KNOWTHECHAT_BACKEND_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    proxy: {
      "/api": { target: backendOrigin, changeOrigin: true },
    },
  },
});
