import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const pagesRoot = resolve(root, ".vite-pages");

await mkdir(pagesRoot, { recursive: true });

await Promise.all([
  copyFile(resolve(root, "edit-schedule.html"), resolve(pagesRoot, "edit.html")),
  copyFile(resolve(root, "view-schedule.html"), resolve(pagesRoot, "view.html")),
]);
