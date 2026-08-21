import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", {
    headers: { accept: "text/html" },
  }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the finished Who Said It product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Who Said It\?<\/title>/i);
  assert.match(html, /How well do you know/);
  assert.match(html, /Chatter pool/);
  assert.match(html, /Open the case/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
  assert.doesNotMatch(html, /Connect Twitch|Sign in with ChatGPT/);
});

test("ships social metadata and the public archive setup surface", async () => {
  const html = await (await render()).text();
  assert.match(html, /property="og:image"/);
  assert.match(html, /Know your chat\. Skip the strangers\./);
  assert.match(html, /Public archives only/);
  assert.match(html, /no Twitch connection/);
});

test("keeps the application surface to the homepage and public archive API", async () => {
  async function routeEntries(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    const routes = [];
    for (const entry of entries) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) routes.push(...await routeEntries(path.join(directory, entry.name), relative));
      else if (/^(?:page|route)\.tsx?$/.test(entry.name)) routes.push(relative.replaceAll("\\", "/"));
    }
    return routes.sort();
  }

  assert.deepEqual(await routeEntries(fileURLToPath(new URL("../app", import.meta.url))), [
    "api/public-archive/route.ts",
    "page.tsx",
  ]);
});
