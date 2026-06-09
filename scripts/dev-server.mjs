import { copyFile, mkdir, watch } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(".");
const pagesRoot = resolve(root, ".vite-pages");
const pages = [
  {
    source: resolve(root, "edit-schedule.html"),
    target: resolve(pagesRoot, "edit.html"),
  },
  {
    source: resolve(root, "view-schedule.html"),
    target: resolve(pagesRoot, "view.html"),
  },
];

async function copyPages() {
  await mkdir(pagesRoot, { recursive: true });
  await Promise.all(pages.map((page) => copyFile(page.source, page.target)));
}

async function copyPage(page) {
  await mkdir(pagesRoot, { recursive: true });
  await copyFile(page.source, page.target);
}

await copyPages();

const server = await createServer({
  configFile: false,
  root: pagesRoot,
  base: "/",
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  plugins: [
    {
      name: "schedule-html-only-routes",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/view" || req.url === "/edit") {
            res.statusCode = 404;
            res.end("Not found");
            return;
          }
          next();
        });
      },
    },
  ],
});

await server.listen();
server.printUrls();

const pending = new Map();

function scheduleCopy(page) {
  clearTimeout(pending.get(page.source));
  pending.set(
    page.source,
    setTimeout(async () => {
      pending.delete(page.source);
      try {
        await copyPage(page);
        server.ws.send({ type: "full-reload", path: "*" });
      } catch (error) {
        server.config.logger.error(
          `Failed to refresh ${page.source}: ${error.message}`,
        );
      }
    }, 75),
  );
}

for (const page of pages) {
  const watcher = watch(page.source);
  (async () => {
    for await (const event of watcher) {
      if (event.eventType === "change" || event.eventType === "rename") {
        scheduleCopy(page);
      }
    }
  })().catch((error) => {
    server.config.logger.error(
      `Stopped watching ${page.source}: ${error.message}`,
    );
  });
}
