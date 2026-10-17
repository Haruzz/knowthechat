import { beforeEach, expect, it, vi } from "vitest";
import {
  messageHistoryKey,
  readSeenHistory,
  rememberMessage,
} from "./seenHistory";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("uses the same opaque SHA-256 identifier as the server", async () => {
  expect(await messageHistoryKey("abc")).toBe("h:ba7816bf8f01cfea414140de");
});

it("combines legacy solo IDs with multiplayer keys and normalizes channels", async () => {
  localStorage.setItem(
    "knowthechat-seen:example",
    JSON.stringify(["abc", null]),
  );
  const key = await messageHistoryKey("multiplayer");
  rememberMessage("@Example", key);
  expect(await readSeenHistory("EXAMPLE")).toEqual([
    await messageHistoryKey("abc"),
    key,
  ]);
});

it("bounds history and tolerates unavailable storage", async () => {
  for (let i = 0; i < 505; i++) rememberMessage("example", String(i));
  expect(await readSeenHistory("example")).toHaveLength(500);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  expect(() => rememberMessage("example", "abc")).not.toThrow();
  expect(await readSeenHistory("example")).toEqual([]);
});
