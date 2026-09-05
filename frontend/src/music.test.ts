import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMusic, type MusicScene } from "./music";

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
  decodeAudioData = vi.fn(async () => ({ duration: 30 }) as AudioBuffer);
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

const response = () => ({
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(8),
});
const fetchMock = vi.fn<
  (url: string, init: RequestInit) => Promise<ReturnType<typeof response>>
>(async () => response());
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
const mix = () =>
  currentAudio().gains[0].gain.setTargetAtTime.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.useFakeTimers();
  MockAudioContext.instances = [];
  MockAudioContext.initialState = "running";
  fetchMock.mockReset().mockImplementation(async () => response());
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("ducks under celebrations and adds modest urgency without restarting the loop", async () => {
    const { result, rerender } = renderHook(useMusic, {
      initialProps: options("gameplay"),
    });
    await flush();
    expect(mix()).toBeCloseTo(0.3);
    rerender({ ...options("gameplay"), urgent: true });
    expect(mix()).toBeCloseTo(0.336);
    act(() => result.current.duck());
    expect(mix()).toBeCloseTo(0.084);
    act(() => vi.advanceTimersByTime(1700));
    expect(mix()).toBeCloseTo(0.336);
    rerender({ ...options("gameplay"), volume: 0 });
    expect(mix()).toBe(0);
    expect(currentAudio().sources).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
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
    expect(currentAudio().sources).toHaveLength(0);
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
      "/audio/gameplay.mp3",
      expect.anything(),
    );
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
