import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectRoom, RoomError } from "./roomConnection";
import { FakeRoomSocket } from "./test/FakeRoomSocket";

const room = { code: "ABC234", revision: 1 };
let dispose: (() => void) | undefined;

function connection(
  overrides: Partial<Parameters<typeof connectRoom<typeof room>>[0]> = {},
) {
  const options = {
    code: "ABC234",
    token: "private-token",
    onRoom: vi.fn(),
    parseRoom: (value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("code" in value) ||
        typeof value.code !== "string" ||
        !("revision" in value) ||
        typeof value.revision !== "number"
      )
        throw new Error("Invalid room snapshot");
      return { code: value.code, revision: value.revision };
    },
    onProblem: vi.fn(() => false),
    fetchRoom: vi.fn(async () => room),
    isBusy: () => false,
    pollInterval: () => 1_500,
    initialPollDelay: 0,
    ...overrides,
  };
  dispose = connectRoom(options);
  return options;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRoomSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeRoomSocket);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live room connection", () => {
  it("authenticates outside the URL and uses automatic heartbeats without state polling", async () => {
    const options = connection();
    const socket = FakeRoomSocket.instances[0];
    expect(new URL(socket.url).pathname).toBe("/api/rooms/ABC234/events");
    expect(new URL(socket.url).protocol).toBe("ws:");
    expect(socket.url).not.toContain("private-token");
    expect(socket.protocols).toEqual([
      "knowthechat.v1",
      "session.private-token",
    ]);
    socket.message({ type: "room", room });
    expect(options.onRoom).toHaveBeenCalledWith(room);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(socket.send).toHaveBeenCalledExactlyOnceWith("ping");
    socket.message("pong");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(options.fetchRoom).not.toHaveBeenCalled();
    expect(FakeRoomSocket.instances).toHaveLength(1);
    expect(options.onProblem).not.toHaveBeenCalled();
  });

  it("falls back after a dropped socket and stops polling once a reconnect delivers a snapshot", async () => {
    const options = connection();
    const first = FakeRoomSocket.instances[0];
    first.message({ type: "room", room });
    first.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(options.fetchRoom).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeRoomSocket.instances).toHaveLength(2);
    FakeRoomSocket.instances[1].message({
      type: "room",
      room: { ...room, revision: 2 },
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(options.fetchRoom).toHaveBeenCalledTimes(1);
    expect(options.onRoom).toHaveBeenLastCalledWith({ ...room, revision: 2 });
  });

  it("detects a missing initial snapshot or heartbeat and reconnects", async () => {
    const options = connection();
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeRoomSocket.instances[0].close).toHaveBeenCalledTimes(1);
    expect(options.fetchRoom).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeRoomSocket.instances[1];
    second.message({ type: "room", room });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(second.send).toHaveBeenCalledExactlyOnceWith("ping");
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(options.onProblem).toHaveBeenCalledTimes(2);
  });

  it("caps reconnection backoff while HTTP snapshots remain available", async () => {
    connection();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const count = FakeRoomSocket.instances.length;
      FakeRoomSocket.instances[count - 1].disconnect();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeRoomSocket.instances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeRoomSocket.instances).toHaveLength(count + 1);
    }
  });

  it("closes hidden pages and reconnects on visibility or browser history restoration", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const options = connection();
    const first = FakeRoomSocket.instances[0];
    first.message({ type: "room", room });
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(first.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(options.fetchRoom).not.toHaveBeenCalled();
    expect(FakeRoomSocket.instances).toHaveLength(1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeRoomSocket.instances).toHaveLength(2);
    window.dispatchEvent(new Event("pagehide"));
    expect(FakeRoomSocket.instances[1].close).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pageshow"));
    expect(FakeRoomSocket.instances).toHaveLength(3);
    dispose?.();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeRoomSocket.instances).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an expired session from an error frame and never retries it", async () => {
    const onProblem = vi.fn(() => true);
    const options = connection({ onProblem });
    const socket = FakeRoomSocket.instances[0];
    socket.message({
      type: "error",
      error: "This lobby has expired.",
      status: 410,
    });
    expect(onProblem).toHaveBeenCalledExactlyOnceWith(
      new RoomError("This lobby has expired.", 410),
    );
    expect(socket.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(options.fetchRoom).not.toHaveBeenCalled();
    expect(FakeRoomSocket.instances).toHaveLength(1);
  });

  it("falls back when browser policy blocks opening a WebSocket", async () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new DOMException("Blocked", "SecurityError");
        }
      },
    );
    const options = connection();
    await vi.advanceTimersByTimeAsync(0);
    expect(options.fetchRoom).toHaveBeenCalledTimes(1);
    expect(options.onRoom).toHaveBeenCalledWith(room);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(options.fetchRoom).toHaveBeenCalledTimes(2);
  });

  it("uses non-overlapping fallback requests when WebSockets are unavailable and aborts on cleanup", async () => {
    vi.stubGlobal("WebSocket", undefined);
    let controller: AbortController | undefined;
    const fetchRoom = vi.fn((nextController: AbortController) => {
      controller = nextController;
      return new Promise<typeof room>(() => {});
    });
    connection({ fetchRoom });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchRoom).toHaveBeenCalledTimes(1);
    expect(FakeRoomSocket.instances).toHaveLength(0);
    dispose?.();
    expect(controller?.signal.aborted).toBe(true);
  });
});
