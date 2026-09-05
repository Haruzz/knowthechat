import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function parameter() {
  return {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

class MockOscillator {
  type = "sine";
  frequency = parameter();
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockGain {
  gain = parameter();
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockBufferSource {
  buffer: { sound: string; duration: number } | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  state: AudioContextState = "running";
  currentTime = 5;
  destination = {};
  oscillators: MockOscillator[] = [];
  sources: MockBufferSource[] = [];
  gains: MockGain[] = [];
  decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => {
    const sample = new Uint8Array(bytes)[0];
    return {
      sound: sample === 1 ? "tick" : sample === 2 ? "tock" : "applause",
      duration: sample === 3 ? 7.645 : 0.24,
    };
  });
  resume = vi.fn(async () => {
    this.state = "running";
  });

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createOscillator() {
    const oscillator = new MockOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    const gain = new MockGain();
    this.gains.push(gain);
    return gain;
  }

  createBufferSource() {
    const source = new MockBufferSource();
    this.sources.push(source);
    return source;
  }
}

beforeEach(() => {
  vi.resetModules();
  MockAudioContext.instances = [];
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: string) =>
        new Response(
          new Uint8Array([
            input.endsWith("-tick.wav")
              ? 1
              : input.endsWith("-tock.wav")
                ? 2
                : 3,
          ]),
        ),
    ),
  );
});

afterEach(async () => {
  const { stopAudio } = await import("./audio");
  stopAudio();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("game audio", () => {
  it("loads the clock recordings once and alternates tick/tock buffers without synthesizing tones", async () => {
    const { prepareAudio, playCountdownTick, stopAudio } =
      await import("./audio");
    await Promise.all([prepareAudio(), prepareAudio()]);
    const audio = MockAudioContext.instances[0];
    for (const second of [5, 4, 3, 2, 1]) playCountdownTick(second);
    expect(audio.sources.map((source) => source.buffer?.sound)).toEqual([
      "tick",
      "tock",
      "tick",
      "tock",
      "tick",
    ]);
    expect(audio.oscillators).toHaveLength(0);
    for (const [index, source] of audio.sources.entries()) {
      expect(source.stop).toHaveBeenCalledWith(audio.currentTime + 0.25);
      expect(audio.gains[index].gain.setValueAtTime).toHaveBeenCalledWith(
        0.7,
        audio.currentTime,
      );
    }
    await prepareAudio();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(audio.decodeAudioData).toHaveBeenCalledTimes(3);
    for (const second of [0, 6, -1, NaN, 2.5]) playCountdownTick(second);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    playCountdownTick(3);
    expect(audio.sources).toHaveLength(5);
    stopAudio();
    expect(audio.sources.at(-1)?.stop).toHaveBeenCalledTimes(2);
    expect(audio.sources.at(-1)?.disconnect).toHaveBeenCalledOnce();
  });

  it("drops ticks until audio is running without queuing them or opening a context", async () => {
    const { prepareAudio, playCountdownTick } = await import("./audio");
    playCountdownTick(5);
    expect(MockAudioContext.instances).toHaveLength(0);
    await prepareAudio();
    const audio = MockAudioContext.instances[0];
    audio.state = "suspended";
    let allowPlayback!: () => void;
    audio.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          allowPlayback = () => {
            audio.state = "running";
            resolve();
          };
        }),
    );
    prepareAudio();
    playCountdownTick(5);
    playCountdownTick(4);
    expect(audio.resume).toHaveBeenCalledOnce();
    allowPlayback();
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.sources).toHaveLength(0);
    playCountdownTick(3);
    expect(audio.sources).toHaveLength(1);
  });

  it("waits for decoded assets without replaying ticks requested while they were loading", async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    );
    const { prepareAudio, playCountdownTick } = await import("./audio");
    const ready = prepareAudio();
    const audio = MockAudioContext.instances[0];
    playCountdownTick(5);
    expect(audio.sources).toHaveLength(0);
    for (const [index, resolve] of pending.entries())
      resolve(new Response(new Uint8Array([index + 1])));
    await ready;
    expect(audio.sources).toHaveLength(0);
    playCountdownTick(4);
    expect(audio.sources[0].buffer?.sound).toBe("tock");
    audio.sources[0].onended?.();
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.gains[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.sources[0].onended).toBeNull();
  });

  it.each(["fetch", "decode", "oversized", "long recording"])(
    "keeps a %s failure optional and does not retry on every gesture",
    async (failure) => {
      if (failure === "fetch")
        vi.mocked(fetch).mockRejectedValue(new Error("Offline"));
      if (failure === "oversized")
        vi.mocked(fetch).mockImplementation(
          async () => new Response(new Uint8Array(1_024 * 1_024 + 1)),
        );
      const { prepareAudio, playCountdownTick } = await import("./audio");
      const ready = prepareAudio();
      const audio = MockAudioContext.instances[0];
      if (failure === "decode")
        audio.decodeAudioData.mockRejectedValue(new Error("Unsupported audio"));
      if (failure === "long recording")
        audio.decodeAudioData.mockResolvedValue({
          sound: "invalid",
          duration: 10,
        });
      await expect(ready).resolves.toBeUndefined();
      await prepareAudio();
      playCountdownTick(5);
      expect(audio.sources).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(3);
      if (failure === "oversized")
        expect(audio.decodeAudioData).not.toHaveBeenCalled();
    },
  );

  it("cleans up a failed buffer playback and keeps later cues usable", async () => {
    const { prepareAudio, playCountdownTick } = await import("./audio");
    await prepareAudio();
    const audio = MockAudioContext.instances[0];
    const failedSource = new MockBufferSource();
    failedSource.start.mockImplementation(() => {
      throw new Error("Device unavailable");
    });
    vi.spyOn(audio, "createBufferSource").mockReturnValueOnce(failedSource);
    expect(() => playCountdownTick(5)).not.toThrow();
    expect(failedSource.disconnect).toHaveBeenCalledOnce();
    expect(audio.gains[0].disconnect).toHaveBeenCalledOnce();
    playCountdownTick(4);
    expect(audio.sources[0].buffer?.sound).toBe("tock");
  });

  it("preloads applause once and overlays final answer and streak sounds independently", async () => {
    const {
      prepareAudio,
      playApplause,
      stopApplause,
      playAnswerSound,
      playStreakSound,
    } = await import("./audio");
    await Promise.all([prepareAudio(), prepareAudio()]);
    const audio = MockAudioContext.instances[0];
    playAnswerSound(true);
    const answer = [...audio.oscillators];
    playApplause();
    const applause = audio.sources[0];
    expect(applause.buffer?.sound).toBe("applause");
    expect(applause.start).toHaveBeenCalledWith(5);
    expect(applause.stop.mock.calls[0][0]).toBeCloseTo(12.655);
    expect(
      audio.gains.at(-1)?.gain.linearRampToValueAtTime,
    ).toHaveBeenCalledWith(0.45, 5.02);
    for (const tone of answer) expect(tone.disconnect).not.toHaveBeenCalled();
    playStreakSound(5);
    expect(applause.disconnect).not.toHaveBeenCalled();
    const streak = audio.oscillators.slice(answer.length);
    stopApplause();
    expect(applause.disconnect).toHaveBeenCalledOnce();
    for (const tone of streak) expect(tone.disconnect).not.toHaveBeenCalled();
    await prepareAudio();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("applause.mp3")),
    ).toHaveLength(1);
  });

  it("bounds applause to one voice, stops all SFX on mute, and releases natural completions", async () => {
    const { prepareAudio, playApplause, stopAudio, playStreakSound } =
      await import("./audio");
    await prepareAudio();
    const audio = MockAudioContext.instances[0];
    playApplause();
    const first = audio.sources[0];
    playApplause();
    expect(first.stop).toHaveBeenCalledTimes(2);
    expect(first.disconnect).toHaveBeenCalledOnce();
    playStreakSound(15);
    stopAudio();
    expect(audio.sources[1].disconnect).toHaveBeenCalledOnce();
    for (const tone of audio.oscillators)
      expect(tone.disconnect).toHaveBeenCalledOnce();
    playApplause();
    const finished = audio.sources.at(-1)!;
    finished.onended?.();
    expect(finished.onended).toBeNull();
    expect(finished.disconnect).toHaveBeenCalledOnce();
    expect(audio.gains.at(-1)?.disconnect).toHaveBeenCalledOnce();
  });

  it("never queues applause requested before preparation, loading, or playback permission", async () => {
    const pending = new Map<string, (response: Response) => void>();
    vi.mocked(fetch).mockImplementation(
      (input) =>
        new Promise<Response>((resolve) => pending.set(String(input), resolve)),
    );
    const { prepareAudio, playApplause, stopApplause } =
      await import("./audio");
    playApplause();
    expect(MockAudioContext.instances).toHaveLength(0);
    const ready = prepareAudio();
    const audio = MockAudioContext.instances[0];
    playApplause();
    stopApplause();
    for (const [path, resolve] of pending)
      resolve(
        new Response(new Uint8Array([path.endsWith("applause.mp3") ? 3 : 1])),
      );
    await ready;
    expect(audio.sources).toHaveLength(0);
    audio.state = "suspended";
    playApplause();
    expect(audio.resume).not.toHaveBeenCalled();
    audio.state = "running";
    expect(audio.sources).toHaveLength(0);
    playApplause();
    expect(audio.sources).toHaveLength(1);
  });

  it("stops applause when the page is hidden or left and never resumes it automatically", async () => {
    const { prepareAudio, playApplause } = await import("./audio");
    await prepareAudio();
    const audio = MockAudioContext.instances[0];
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    playApplause();
    expect(audio.sources).toHaveLength(0);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    playApplause();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(audio.sources).toHaveLength(1);
    playApplause();
    window.dispatchEvent(new Event("pagehide"));
    expect(audio.sources[1].disconnect).toHaveBeenCalledOnce();
  });

  it.each(["fetch", "decode", "oversized", "too long"])(
    "isolates an applause %s failure from clock playback without repeated downloads",
    async (failure) => {
      const originalFetch = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation((input, init) => {
        if (String(input).endsWith("applause.mp3")) {
          if (failure === "fetch") return Promise.reject(new Error("Offline"));
          if (failure === "oversized")
            return Promise.resolve(
              new Response(new Uint8Array(1_024 * 1_024 + 1)),
            );
        }
        return originalFetch(input, init);
      });
      const { prepareAudio, playApplause, playCountdownTick } =
        await import("./audio");
      const ready = prepareAudio();
      const audio = MockAudioContext.instances[0];
      const decode = audio.decodeAudioData.getMockImplementation()!;
      audio.decodeAudioData.mockImplementation(async (bytes) => {
        const buffer = await decode(bytes);
        if (buffer.sound === "applause") {
          if (failure === "decode") throw new Error("Unsupported format");
          if (failure === "too long") return { ...buffer, duration: 12.01 };
        }
        return buffer;
      });
      await expect(ready).resolves.toBeUndefined();
      await prepareAudio();
      playApplause();
      expect(audio.sources).toHaveLength(0);
      playCountdownTick(5);
      expect(audio.sources[0].buffer?.sound).toBe("tick");
      expect(fetch).toHaveBeenCalledTimes(3);
      if (failure === "oversized")
        expect(audio.decodeAudioData).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps applause available even if the independent clock recordings fail", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).endsWith("applause.mp3")
        ? new Response(new Uint8Array([3]))
        : new Response(null, { status: 404 }),
    );
    const { prepareAudio, playApplause, playCountdownTick } =
      await import("./audio");
    await prepareAudio();
    playCountdownTick(5);
    const audio = MockAudioContext.instances[0];
    expect(audio.sources).toHaveLength(0);
    playApplause();
    expect(audio.sources[0].buffer?.sound).toBe("applause");
  });

  it("retries a pending unlock on a fresh gesture without replaying old countdown cues", async () => {
    const { prepareAudio, playCountdownTick, playAnswerSound, stopAudio } =
      await import("./audio");
    await prepareAudio();
    const audio = MockAudioContext.instances[0];
    audio.state = "suspended";
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    audio.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = prepareAudio();
    playCountdownTick(5);
    audio.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSecond = () => {
            audio.state = "running";
            resolve();
          };
        }),
    );
    const second = prepareAudio();
    playCountdownTick(4);
    expect(audio.resume).toHaveBeenCalledTimes(2);
    resolveFirst();
    await first;
    // Settling an older attempt must not erase the newer in-flight attempt.
    playAnswerSound(false);
    expect(audio.resume).toHaveBeenCalledTimes(2);
    stopAudio();
    resolveSecond();
    await second;
    expect(audio.oscillators).toHaveLength(0);
    expect(audio.sources).toHaveLength(0);
    playCountdownTick(3);
    expect(audio.sources).toHaveLength(1);
  });

  it("gives each milestone a distinct melody and keeps later milestones legendary", async () => {
    const { playStreakSound } = await import("./audio");
    playStreakSound(4);
    expect(MockAudioContext.instances).toHaveLength(0);

    const melodies: number[][] = [];
    for (const streak of [5, 10, 15, 20]) {
      playStreakSound(streak);
      const audio = MockAudioContext.instances[0];
      melodies.push(
        audio.oscillators.map(
          (oscillator) => oscillator.frequency.setValueAtTime.mock.calls[0][0],
        ),
      );
      audio.oscillators = [];
    }
    expect(melodies[0]).not.toEqual(melodies[1]);
    expect(melodies[1]).not.toEqual(melodies[2]);
    expect(melodies[2]).toEqual(melodies[3]);
    expect(MockAudioContext.instances).toHaveLength(1);
  });

  it("bounds playback and releases nodes after the sound ends", async () => {
    const { playStreakSound, playAnswerSound } = await import("./audio");
    playStreakSound(15);
    const audio = MockAudioContext.instances[0];
    const previous = [...audio.oscillators];
    const previousGains = [...audio.gains];

    for (const [index, oscillator] of previous.entries()) {
      expect(oscillator.stop.mock.calls[0][0]).toBeLessThanOrEqual(
        audio.currentTime + 2,
      );
      expect(
        previousGains[index].gain.linearRampToValueAtTime.mock.calls[0][0],
      ).toBeLessThanOrEqual(0.075);
    }

    playAnswerSound(false);
    for (const [index, oscillator] of previous.entries()) {
      expect(oscillator.stop).toHaveBeenCalledTimes(2);
      expect(oscillator.disconnect).toHaveBeenCalledOnce();
      expect(previousGains[index].disconnect).toHaveBeenCalledOnce();
    }

    const last = audio.oscillators.at(-1)!;
    last.onended?.();
    expect(last.disconnect).toHaveBeenCalledOnce();
    expect(audio.gains.at(-1)!.disconnect).toHaveBeenCalledOnce();
    expect(last.onended).toBeNull();
  });

  it("keeps correct and incorrect answer feedback distinct", async () => {
    const { playAnswerSound } = await import("./audio");
    playAnswerSound(true);
    const audio = MockAudioContext.instances[0];
    const correct = audio.oscillators.map(
      (oscillator) => oscillator.frequency.setValueAtTime.mock.calls[0][0],
    );
    audio.oscillators = [];
    playAnswerSound(false);
    const incorrect = audio.oscillators.map(
      (oscillator) => oscillator.frequency.setValueAtTime.mock.calls[0][0],
    );
    expect(correct[0]).toBeLessThan(correct.at(-1)!);
    expect(incorrect[0]).toBeGreaterThan(incorrect.at(-1)!);
  });

  it("unlocks audio without making a sound and only plays the latest pending request", async () => {
    const { prepareAudio, playAnswerSound, playStreakSound } =
      await import("./audio");
    prepareAudio();
    const audio = MockAudioContext.instances[0];
    expect(audio.oscillators).toHaveLength(0);
    audio.state = "suspended";
    let allowPlayback!: () => void;
    audio.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          allowPlayback = () => {
            audio.state = "running";
            resolve();
          };
        }),
    );

    prepareAudio();
    playAnswerSound(false);
    playStreakSound(5);
    expect(audio.resume).toHaveBeenCalledOnce();
    expect(audio.oscillators).toHaveLength(0);
    allowPlayback();
    await vi.waitFor(() => expect(audio.oscillators).toHaveLength(5));
    expect(MockAudioContext.instances).toHaveLength(1);
  });

  it("treats missing Web Audio and rejected playback permission as optional", async () => {
    const { prepareAudio, playAnswerSound, playStreakSound } =
      await import("./audio");
    vi.stubGlobal("AudioContext", undefined);
    expect(() => {
      prepareAudio();
      playAnswerSound(true);
      playStreakSound(15);
    }).not.toThrow();

    vi.stubGlobal("AudioContext", MockAudioContext);
    prepareAudio();
    const audio = MockAudioContext.instances[0];
    audio.state = "suspended";
    audio.resume.mockRejectedValue(new Error("Playback blocked"));
    expect(() => {
      prepareAudio();
      playStreakSound(5);
    }).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audio.oscillators).toHaveLength(0);
  });
  it("mutes active tones immediately and cancels sounds waiting for permission", async () => {
    const { playStreakSound, stopAudio } = await import("./audio");
    playStreakSound(15);
    const audio = MockAudioContext.instances[0];
    stopAudio();
    for (const oscillator of audio.oscillators) {
      expect(oscillator.stop).toHaveBeenCalledTimes(2);
      expect(oscillator.disconnect).toHaveBeenCalledOnce();
    }

    audio.oscillators = [];
    audio.state = "suspended";
    let allowPlayback!: () => void;
    audio.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          allowPlayback = () => {
            audio.state = "running";
            resolve();
          };
        }),
    );
    playStreakSound(5);
    stopAudio();
    allowPlayback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audio.oscillators).toHaveLength(0);
  });
});
