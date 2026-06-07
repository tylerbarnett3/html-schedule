import { resolve } from "node:path";
import { defineConfig } from "vite";

const pagesRoot = resolve(".vite-pages");

export default defineConfig({
  root: pagesRoot,
  base: "/html-schedule/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        edit: resolve(pagesRoot, "edit.html"),
        view: resolve(pagesRoot, "view.html"),
      },
    },
  },
});
