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

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  state: AudioContextState = "running";
  currentTime = 5;
  destination = {};
  oscillators: MockOscillator[] = [];
  gains: MockGain[] = [];
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
}

beforeEach(() => {
  vi.resetModules();
  MockAudioContext.instances = [];
  vi.stubGlobal("AudioContext", MockAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("game audio", () => {
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
