import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A separate development entry; the normal build never imports this page.
export default defineConfig(({ command }) => {
  if (command !== "serve") {
    throw new Error(
      "The streak playground is local only. Use npm run dev:streaks.",
    );
  }
  return {
    root: fileURLToPath(new URL("./playground", import.meta.url)),
    publicDir: false,
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
      fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
    },
  };
});
