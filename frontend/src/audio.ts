type Tone = {
  frequency: number;
  offset: number;
  duration: number;
  type?: OscillatorType;
  volume?: number;
  endFrequency?: number;
};

type Voice = { oscillator: OscillatorNode; gain: GainNode };

let context: AudioContext | null = null;
let resumeAttempt: Promise<void> | null = null;
let playbackRequest = 0;
const voices = new Set<Voice>();

function getContext(): AudioContext | null {
  try {
    if (!context || context.state === "closed") {
      if (typeof window.AudioContext !== "function") return null;
      context = new window.AudioContext();
      resumeAttempt = null;
    }
    return context;
  } catch {
    return null;
  }
}

function resume(audio: AudioContext): Promise<void> {
  if (audio.state === "running") return Promise.resolve();
  if (!resumeAttempt) {
    resumeAttempt = audio.resume().finally(() => {
      resumeAttempt = null;
    });
  }
  return resumeAttempt;
}

/** Call from a user gesture so later multiplayer reveals can play audio. */
export function prepareAudio(): void {
  try {
    const audio = getContext();
    if (audio) void resume(audio).catch(() => {});
  } catch {
    // Audio is optional, including in browsers that block playback.
  }
}

function release(voice: Voice): void {
  voice.oscillator.onended = null;
  voice.oscillator.disconnect();
  voice.gain.disconnect();
  voices.delete(voice);
}

function stopVoices(): void {
  for (const voice of voices) {
    try {
      voice.oscillator.stop();
    } catch {
      // The context may already have been closed by the browser.
    } finally {
      release(voice);
    }
  }
}

/** Mute immediately, including sounds waiting for browser permission. */
export function stopAudio(): void {
  playbackRequest += 1;
  stopVoices();
}

function play(tones: readonly Tone[]): void {
  const request = ++playbackRequest;
  try {
    const audio = getContext();
    if (!audio) return;
    const start = () => {
      // Never replay a queue of old reveals after the browser allows audio.
      if (request !== playbackRequest || audio.state !== "running") return;
      try {
        stopVoices();
        for (const tone of tones) {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          const voice = { oscillator, gain };
          voices.add(voice);
          oscillator.onended = () => release(voice);
          const begins = audio.currentTime + tone.offset;
          const ends = begins + tone.duration;
          oscillator.type = tone.type ?? "sine";
          oscillator.frequency.setValueAtTime(tone.frequency, begins);
          if (tone.endFrequency) {
            oscillator.frequency.exponentialRampToValueAtTime(
              tone.endFrequency,
              ends,
            );
          }
          gain.gain.setValueAtTime(0, begins);
          gain.gain.linearRampToValueAtTime(
            tone.volume ?? 0.065,
            begins + 0.02,
          );
          gain.gain.exponentialRampToValueAtTime(0.001, ends);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.start(begins);
          oscillator.stop(ends + 0.02);
        }
      } catch {
        for (const voice of voices) release(voice);
      }
    };
    if (audio.state === "running") start();
    else
      void resume(audio)
        .then(start)
        .catch(() => {});
  } catch {
    // A sound must never interrupt an answer or a round transition.
  }
}

export function playAnswerSound(correct: boolean): void {
  const frequencies = correct
    ? [523.25, 659.25, 783.99]
    : [392, 329.63, 261.63];
  play(
    frequencies.map((frequency, index) => ({
      frequency,
      offset: index * (correct ? 0.1 : 0.18),
      duration: correct ? 0.28 : 0.32,
      type: correct ? "sine" : "triangle",
      volume: correct ? 0.075 : 0.055,
      endFrequency: correct ? undefined : frequency * 0.82,
    })),
  );
}

export function playStreakSound(streak: number): void {
  if (streak < 5) return;
  if (streak < 10) {
    // A rising ignition underneath a quick, warm arpeggio.
    play([
      {
        frequency: 98,
        endFrequency: 392,
        offset: 0,
        duration: 0.35,
        type: "triangle",
        volume: 0.045,
      },
      ...[523.25, 659.25, 783.99, 1046.5].map((frequency, index) => ({
        frequency,
        offset: 0.12 + index * 0.11,
        duration: index === 3 ? 0.48 : 0.22,
        type: "triangle" as const,
        volume: 0.065,
      })),
    ]);
  } else if (streak < 15) {
    // A quicker double rise, with a punchy final chord.
    play([
      ...[523.25, 783.99, 1046.5, 659.25, 987.77, 1318.51].map(
        (frequency, index) => ({
          frequency,
          offset: index * 0.09,
          duration: 0.22,
          type: "triangle" as const,
          volume: 0.055,
        }),
      ),
      ...[523.25, 783.99, 1046.5].map((frequency) => ({
        frequency,
        offset: 0.6,
        duration: 0.6,
        volume: 0.045,
      })),
    ]);
  } else {
    // Bright chimes resolve into a longer, four-note victory chord.
    play([
      ...[1046.5, 1318.51, 1567.98, 2093].map((frequency, index) => ({
        frequency,
        offset: index * 0.12,
        duration: 0.42,
        volume: 0.055,
      })),
      ...[523.25, 659.25, 783.99, 1046.5].map((frequency) => ({
        frequency,
        offset: 0.5,
        duration: 1.05,
        volume: 0.035,
      })),
    ]);
  }
}
