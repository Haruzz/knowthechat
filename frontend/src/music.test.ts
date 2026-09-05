import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMusic, type MusicScene } from "./music";

type TestBuffer = AudioBuffer & { track: string };

function parameter() {
  return {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

class MockGain {
  gain = parameter();
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockSource {
  buffer: AudioBuffer | null = null;
  loop = false;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  static initialState: AudioContextState = "running";
  state = MockAudioContext.initialState;
  currentTime = 5;
  destination = {};
  sources: MockSource[] = [];
  gains: MockGain[] = [];
  decodeAudioData = vi.fn<(bytes: ArrayBuffer) => Promise<AudioBuffer>>(
    async (bytes: ArrayBuffer) =>
      ({ duration: 30, track: new TextDecoder().decode(bytes) }) as TestBuffer,
  );
  resume = vi.fn(async () => {
    this.state = "running";
  });
  suspend = vi.fn(async () => {
    this.state = "suspended";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createBufferSource() {
    const source = new MockSource();
    this.sources.push(source);
    return source;
  }

  createGain() {
    const gain = new MockGain();
    this.gains.push(gain);
    return gain;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const response = (track = "") => ({
  ok: true,
  arrayBuffer: async () => new TextEncoder().encode(track).buffer,
});
const fetchMock = vi.fn<
  (url: string, init: RequestInit) => Promise<ReturnType<typeof response>>
>(async (url) => response(url));
const gameplayUrls = [
  "/audio/gameplay-penguin-town.mp3",
  "/audio/gameplay-sanctuary.mp3",
  "/audio/gameplay-sketchbook-2025-12-11.mp3",
  "/audio/gameplay-sketchbook-2024-10-14.mp3",
];
const options = (scene: MusicScene = "lobby", enabled = true) => ({
  enabled,
  scene,
  volume: 0.4,
  urgent: false,
});
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
const currentAudio = () => MockAudioContext.instances.at(-1)!;
const currentTrack = () =>
  (
    currentAudio().sources.at(-1)?.buffer as
      (AudioBuffer & { track: string }) | null
  )?.track;
const finishTrack = async () => {
  act(() => currentAudio().sources.at(-1)?.onended?.());
  await flush();
};
const mix = () =>
  currentAudio().gains[0].gain.setTargetAtTime.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.useFakeTimers();
  MockAudioContext.instances = [];
  MockAudioContext.initialState = "running";
  fetchMock.mockReset().mockImplementation(async (url) => response(url));
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(Math, "random").mockReturnValue(0.99);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("background music", () => {
  it("loads nothing while off, unlocks on the toggle gesture, and keeps controls stable", async () => {
    const { result, rerender } = renderHook(useMusic, {
      initialProps: options("lobby", false),
    });
    const controls = result.current;
    expect(MockAudioContext.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => result.current.prepare());
    expect(currentAudio().resume).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(options());
    await flush();
    expect(result.current).toBe(controls);
    expect(fetchMock).toHaveBeenCalledWith(
      "/audio/lobby.mp3",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(currentAudio().sources).toHaveLength(1);
    expect(currentAudio().sources[0].loop).toBe(true);

    rerender(options("lobby", false));
    expect(currentAudio().sources[0].disconnect).toHaveBeenCalledOnce();
    expect(currentAudio().suspend).toHaveBeenCalledOnce();
    rerender(options());
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(currentAudio().sources).toHaveLength(2);
  });

  it("crossfades scenes without accumulating voices during rapid changes", async () => {
    const { rerender } = renderHook(useMusic, { initialProps: options() });
    await flush();
    const audio = currentAudio();
    rerender(options("gameplay"));
    await flush();
    expect(audio.sources).toHaveLength(2);
    expect(audio.sources[0].stop).toHaveBeenCalledWith(5.4);
    expect(audio.sources[1].start).toHaveBeenCalledOnce();
    rerender(options());
    await flush();
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.sources).toHaveLength(3);
    act(() => vi.advanceTimersByTime(500));
    expect(audio.sources[1].disconnect).toHaveBeenCalledOnce();
    expect(audio.sources[2].disconnect).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ignores stale decode results after a scene change or turning music off", async () => {
    const firstDecode = deferred<AudioBuffer>();
    const { result, rerender } = renderHook(useMusic, {
      initialProps: options("lobby", false),
    });
    act(() => result.current.prepare());
    const audio = currentAudio();
    audio.decodeAudioData.mockImplementationOnce(() => firstDecode.promise);
    rerender(options());
    await flush();
    const firstSignal = fetchMock.mock.calls[0][1] as { signal: AbortSignal };
    rerender(options("gameplay"));
    await flush();
    expect(firstSignal.signal.aborted).toBe(true);
    expect(audio.sources).toHaveLength(1);
    await act(async () => firstDecode.resolve({ duration: 99 } as AudioBuffer));
    expect(audio.sources).toHaveLength(1);
    expect(audio.sources[0].buffer?.duration).toBe(30);

    rerender(options("lobby"));
    rerender(options("lobby", false));
    await flush();
    expect(audio.sources).toHaveLength(1);
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
  });

  it("silences hidden pages, resumes the current scene, and disposes all resources", async () => {
    const { rerender, unmount } = renderHook(useMusic, {
      initialProps: options(),
    });
    await flush();
    const audio = currentAudio();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.suspend).toHaveBeenCalledOnce();
    rerender(options("gameplay"));
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(audio.sources).toHaveLength(2);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(audio.sources[1].disconnect).toHaveBeenCalledOnce();
    act(() => window.dispatchEvent(new Event("pageshow")));
    await flush();
    expect(audio.sources).toHaveLength(3);
    unmount();
    expect(audio.sources[2].disconnect).toHaveBeenCalledOnce();
    expect(audio.close).toHaveBeenCalledOnce();
    expect(audio.gains[0].disconnect).toHaveBeenCalledOnce();
    act(() => window.dispatchEvent(new Event("pointerdown")));
    expect(MockAudioContext.instances).toHaveLength(1);
  });

  it("cancels pending downloads and playback on silence and unmount", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementationOnce(() => pending.promise);
    const { rerender, unmount } = renderHook(useMusic, {
      initialProps: options(),
    });
    const audio = currentAudio();
    const request = fetchMock.mock.calls[0][1] as { signal: AbortSignal };
    rerender(options("silent"));
    expect(request.signal.aborted).toBe(true);
    await act(async () => pending.resolve(response()));
    expect(audio.decodeAudioData).not.toHaveBeenCalled();
    expect(audio.sources).toHaveLength(0);

    const decode = deferred<AudioBuffer>();
    audio.decodeAudioData.mockImplementationOnce(() => decode.promise);
    rerender(options());
    await flush();
    unmount();
    await act(async () => decode.resolve({ duration: 30 } as AudioBuffer));
    expect(audio.sources).toHaveLength(0);
    expect(audio.close).toHaveBeenCalledOnce();
  });

  it("retries blocked playback on a user gesture and plays only the latest scene", async () => {
    const blocked = deferred<void>();
    const { result, rerender } = renderHook(useMusic, {
      initialProps: options("lobby", false),
    });
    act(() => result.current.prepare());
    await flush();
    const audio = currentAudio();
    audio.state = "suspended";
    audio.resume.mockImplementationOnce(() => blocked.promise);
    rerender(options());
    await flush();
    expect(audio.sources).toHaveLength(0);
    audio.resume.mockRejectedValueOnce(new Error("NotAllowedError"));
    rerender(options("gameplay"));
    await flush();
    expect(audio.sources).toHaveLength(0);
    act(() => window.dispatchEvent(new Event("keydown")));
    await flush();
    expect(audio.sources).toHaveLength(1);
    await act(async () => blocked.resolve());
    expect(audio.sources).toHaveLength(1);
  });

  it("ducks celebrations and fully mutes final seconds without restarting the track", async () => {
    const { result, rerender } = renderHook(useMusic, {
      initialProps: options("gameplay"),
    });
    await flush();
    expect(mix()).toBeCloseTo(0.3);
    act(() => result.current.duck());
    expect(mix()).toBeCloseTo(0.075);
    rerender({ ...options("gameplay"), urgent: true });
    expect(mix()).toBe(0);
    rerender({ ...options("gameplay"), urgent: true, volume: 1 });
    expect(mix()).toBe(0);
    act(() => vi.advanceTimersByTime(1700));
    expect(mix()).toBe(0);
    rerender(options("gameplay"));
    expect(mix()).toBeCloseTo(0.3);
    rerender({ ...options("gameplay"), volume: 0 });
    expect(mix()).toBe(0);
    expect(currentAudio().sources).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the final celebration ducked through the transition back to the lobby", async () => {
    const { result, rerender } = renderHook(useMusic, {
      initialProps: options("gameplay"),
    });
    await flush();
    act(() => result.current.duck(1800));
    act(() => vi.advanceTimersByTime(400));
    rerender(options("lobby"));
    await flush();
    expect(mix()).toBeCloseTo(0.1);
    act(() => vi.advanceTimersByTime(1399));
    expect(mix()).toBeCloseTo(0.1);
    act(() => vi.advanceTimersByTime(1));
    expect(mix()).toBeCloseTo(0.4);

    act(() => result.current.duck(1800));
    rerender(options("lobby", false));
    rerender(options("lobby"));
    await flush();
    expect(mix()).toBeCloseTo(0.4);
  });

  it("stays muted if playback permission arrives after music was disabled", async () => {
    const { result, rerender } = renderHook(useMusic, {
      initialProps: options("lobby", false),
    });
    act(() => result.current.prepare());
    await flush();
    const audio = currentAudio();
    const permission = deferred<void>();
    audio.resume.mockImplementationOnce(async () => {
      await permission.promise;
      audio.state = "running";
    });
    rerender(options());
    await flush();
    expect(audio.sources).toHaveLength(0);
    rerender(options("lobby", false));
    await act(async () => permission.resolve());
    expect(audio.sources).toHaveLength(0);
    expect(audio.state).toBe("suspended");
  });

  it("contains missing Web Audio, network failures, and decoding errors", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const { result, rerender } = renderHook(useMusic, {
      initialProps: options(),
    });
    expect(() => result.current.prepare()).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal("AudioContext", MockAudioContext);
    fetchMock.mockRejectedValueOnce(new Error("Offline"));
    act(() => result.current.prepare());
    await flush();
    expect(currentAudio().sources).toHaveLength(0);
    currentAudio().decodeAudioData.mockRejectedValueOnce(
      new Error("Bad audio"),
    );
    rerender(options("gameplay"));
    await flush();
    expect(currentAudio().sources).toHaveLength(1);
    expect(currentTrack()).toBe(gameplayUrls[1]);
    act(() => window.dispatchEvent(new Event("pointerdown")));
    await flush();
    expect(currentAudio().sources).toHaveLength(1);
  });

  it("recovers from an externally closed context on the next gesture", async () => {
    renderHook(useMusic, { initialProps: options("gameplay") });
    await flush();
    const closed = currentAudio();
    await act(async () => closed.close());
    act(() => window.dispatchEvent(new Event("pointerdown")));
    await flush();
    expect(MockAudioContext.instances).toHaveLength(2);
    expect(closed.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(currentAudio().sources).toHaveLength(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      gameplayUrls[1],
      expect.anything(),
    );
  });

  it("plays every complete gameplay track once per shuffle and avoids a repeat at the boundary", async () => {
    const { rerender } = renderHook(useMusic, {
      initialProps: options("gameplay"),
    });
    await flush();
    const played = [currentTrack()];
    expect(currentAudio().sources[0].loop).toBe(false);
    expect(currentAudio().sources[0].stop).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      gameplayUrls.slice(0, 2),
    );
    rerender({ ...options("gameplay"), volume: 0.2, urgent: true });
    await flush();
    expect(currentAudio().sources).toHaveLength(1);
    for (let index = 0; index < 4; index += 1) {
      // Make the next shuffle initially choose the last song of the first bag.
      if (index === 2) vi.mocked(Math.random).mockReturnValueOnce(0);
      await finishTrack();
      played.push(currentTrack());
    }
    expect(played.slice(0, 4)).toEqual(gameplayUrls);
    expect(played[4]).not.toBe(played[3]);
    expect(played[4]).toBe(gameplayUrls[1]);
    for (const source of currentAudio().sources.slice(0, -1)) {
      expect(source.buffer).toBeNull();
      expect(source.disconnect).toHaveBeenCalledOnce();
    }
  });

  it("resumes the partial gameplay track after a silent leaderboard and advances when it finishes", async () => {
    const { rerender } = renderHook(useMusic, {
      initialProps: options("gameplay"),
    });
    await flush();
    const audio = currentAudio();
    expect(currentTrack()).toBe(gameplayUrls[0]);
    audio.currentTime = 12;
    rerender(options("silent"));
    await flush();
    act(() => vi.advanceTimersByTime(5000));
    rerender(options("gameplay"));
    await flush();
    expect(currentTrack()).toBe(gameplayUrls[0]);
    expect(audio.sources.at(-1)?.start).toHaveBeenCalledWith(0, 7);
    expect(
      audio.gains.at(-1)?.gain.linearRampToValueAtTime,
    ).toHaveBeenLastCalledWith(0, 35);
    audio.currentTime = 20;
    rerender(options("silent"));
    await flush();
    rerender(options("gameplay"));
    await flush();
    expect(audio.sources.at(-1)?.start).toHaveBeenCalledWith(0, 15);
    await finishTrack();
    expect(currentTrack()).toBe(gameplayUrls[1]);
    expect(audio.sources.at(-1)?.start).toHaveBeenCalledWith(0, 0);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === gameplayUrls[0]),
    ).toHaveLength(1);
  });

  it.each(["lobby", "disabled", "hidden"] as const)(
    "preserves the gameplay cursor while %s",
    async (interruption) => {
      const { rerender } = renderHook(useMusic, {
        initialProps: options("gameplay"),
      });
      await flush();
      const audio = currentAudio();
      audio.currentTime = 14;
      if (interruption === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        act(() => document.dispatchEvent(new Event("visibilitychange")));
      } else
        rerender(
          options(
            interruption === "lobby" ? "lobby" : "gameplay",
            interruption !== "disabled",
          ),
        );
      await flush();
      if (interruption === "lobby") audio.currentTime = 24;
      if (interruption === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(false);
        act(() => document.dispatchEvent(new Event("visibilitychange")));
      } else rerender(options("gameplay"));
      await flush();
      expect(currentTrack()).toBe(gameplayUrls[0]);
      expect(audio.sources.at(-1)?.start).toHaveBeenCalledWith(0, 9);
    },
  );

  it("advances if the song finished exactly as the leaderboard silenced it", async () => {
    const { rerender } = renderHook(useMusic, {
      initialProps: options("gameplay"),
    });
    await flush();
    currentAudio().currentTime = 35;
    rerender(options("silent"));
    await flush();
    rerender(options("gameplay"));
    await flush();
    expect(currentTrack()).toBe(gameplayUrls[1]);
    expect(currentAudio().sources.at(-1)?.start).toHaveBeenCalledWith(0, 0);
  });

  it("keeps the lobby cached while evicting completed gameplay tracks", async () => {
    const { rerender } = renderHook(useMusic, { initialProps: options() });
    await flush();
    rerender(options("gameplay"));
    await flush();
    for (let index = 0; index < 4; index += 1) await finishTrack();
    expect(
      fetchMock.mock.calls.filter(([url]) => url === gameplayUrls[0]),
    ).toHaveLength(2);
    expect(currentTrack()).toBe(gameplayUrls[0]);
    rerender(options());
    await flush();
    expect(currentTrack()).toBe("/audio/lobby.mp3");
    expect(currentAudio().sources.at(-1)?.loop).toBe(true);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/audio/lobby.mp3"),
    ).toHaveLength(1);
  });

  it("aborts a prefetched track when disabled and never plays its stale result", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation((url) =>
      url === gameplayUrls[1]
        ? pending.promise
        : Promise.resolve(response(url)),
    );
    const { rerender } = renderHook(useMusic, {
      initialProps: options("gameplay"),
    });
    await flush();
    const prefetch = fetchMock.mock.calls[1][1].signal;
    expect(currentAudio().sources).toHaveLength(1);
    rerender(options("gameplay", false));
    expect(prefetch?.aborted).toBe(true);
    await act(async () => pending.resolve(response(gameplayUrls[1])));
    expect(currentAudio().decodeAudioData).toHaveBeenCalledOnce();
    expect(currentAudio().sources).toHaveLength(1);
    expect(currentAudio().sources[0].buffer).toBeNull();
  });

  it("waits for an unfinished lookahead and starts it exactly once after the current track ends", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation((url) =>
      url === gameplayUrls[1]
        ? pending.promise
        : Promise.resolve(response(url)),
    );
    renderHook(useMusic, { initialProps: options("gameplay") });
    await flush();
    await finishTrack();
    expect(currentAudio().sources).toHaveLength(1);
    expect(currentAudio().sources[0].buffer).toBeNull();
    await act(async () => pending.resolve(response(gameplayUrls[1])));
    expect(currentAudio().sources).toHaveLength(2);
    expect(currentTrack()).toBe(gameplayUrls[1]);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === gameplayUrls[1]),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      gameplayUrls.slice(0, 3),
    );
  });

  it("skips unavailable tracks once and stays silent without a retry storm when all fail", async () => {
    fetchMock.mockRejectedValue(new Error("Offline"));
    const { rerender } = renderHook(useMusic, {
      initialProps: options("gameplay"),
    });
    await flush();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(gameplayUrls);
    expect(currentAudio().sources).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(60000);
      window.dispatchEvent(new Event("pointerdown"));
      window.dispatchEvent(new Event("keydown"));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockImplementation(async (url) => response(url));
    rerender(options("gameplay", false));
    rerender(options("gameplay"));
    await flush();
    expect(currentAudio().sources).toHaveLength(1);
    expect(currentTrack()).toBe(gameplayUrls[0]);
  });

  it("keeps scene changes working when the browser rejects an outgoing fade", async () => {
    const { rerender } = renderHook(useMusic, { initialProps: options() });
    await flush();
    const audio = currentAudio();
    audio.sources[0].stop.mockImplementation(() => {
      throw new Error("Device lost");
    });
    expect(() => rerender(options("gameplay"))).not.toThrow();
    await flush();
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.sources[1].start).toHaveBeenCalledOnce();
  });

  it("survives Strict Mode setup cleanup without duplicate playback", async () => {
    renderHook(useMusic, { initialProps: options(), reactStrictMode: true });
    await flush();
    expect(MockAudioContext.instances).toHaveLength(2);
    expect(MockAudioContext.instances[0].close).toHaveBeenCalledOnce();
    expect(MockAudioContext.instances[0].sources).toHaveLength(0);
    expect(currentAudio().sources).toHaveLength(1);
  });
});
