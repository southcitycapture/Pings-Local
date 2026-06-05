import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
        overlay: resolve(__dirname, "src/overlay.html"),
        options: resolve(__dirname, "src/options.html"),
        directChat: resolve(__dirname, "src/direct-chat.html"),
      },
    },
  },
});
