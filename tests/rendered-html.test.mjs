import assert from "node:assert/strict";
import test from "node:test";

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
