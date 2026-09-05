type Tone = {
  frequency: number;
  offset: number;
  duration: number;
  type?: OscillatorType;
  volume?: number;
  endFrequency?: number;
};

type Voice = { source: AudioScheduledSourceNode; gain: GainNode };
type ClockSound = "tick" | "tock";

const MAX_CLOCK_BYTES = 128 * 1_024;
const clockBuffers = new Map<ClockSound, AudioBuffer>();
let clockLoad: Promise<void> | null = null;

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

function resume(audio: AudioContext, fromGesture = false): Promise<void> {
  if (audio.state === "running") return Promise.resolve();
  if (!resumeAttempt || fromGesture) {
    // An autoplay-blocked resume can remain pending until a fresh gesture retries it.
    const attempt: Promise<void> = audio.resume().finally(() => {
      if (resumeAttempt === attempt) resumeAttempt = null;
    });
    resumeAttempt = attempt;
  }
  return resumeAttempt;
}

async function loadClockBuffer(
  audio: AudioContext,
  sound: ClockSound,
): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`/audio/countdown-${sound}.wav`, {
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_CLOCK_BYTES) {
          await reader.cancel();
          return;
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (controller.signal.aborted || length === 0) return;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const buffer = await audio.decodeAudioData(bytes.buffer);
    if (
      !controller.signal.aborted &&
      buffer.duration > 0 &&
      buffer.duration <= 1
    )
      clockBuffers.set(sound, buffer);
  } catch {
    // Missing or undecodable clock assets must not interrupt gameplay.
  } finally {
    window.clearTimeout(timeout);
  }
}

function preloadClock(audio: AudioContext): Promise<void> {
  // Cache the attempt as well as successful buffers: gestures cannot cause a
  // request storm if a static asset is unavailable. A reload permits a retry.
  clockLoad ??= Promise.all([
    loadClockBuffer(audio, "tick"),
    loadClockBuffer(audio, "tock"),
  ]).then(() => {});
  return clockLoad;
}

/** Call from a user gesture so later multiplayer reveals can play audio. */
export function prepareAudio(): Promise<void> {
  try {
    const audio = getContext();
    if (audio)
      return Promise.all([resume(audio, true), preloadClock(audio)]).then(
        () => {},
        () => {},
      );
  } catch {
    // Audio is optional, including in browsers that block playback.
  }
  return Promise.resolve();
}

function release(voice: Voice): void {
  voice.source.onended = null;
  voices.delete(voice);
  try {
    voice.source.disconnect();
  } catch {
    /* The device can close independently. */
  }
  try {
    voice.gain.disconnect();
  } catch {
    /* Already disconnected. */
  }
}

function stopVoices(): void {
  for (const voice of voices) {
    try {
      voice.source.stop();
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
  try {
    const audio = getContext();
    if (!audio) return;
    const request = ++playbackRequest;
    const start = () => {
      // Never replay a queue of old reveals after the browser allows audio.
      if (request !== playbackRequest || audio.state !== "running") return;
      try {
        stopVoices();
        for (const tone of tones) {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          const voice = { source: oscillator, gain };
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

/** Countdown cues expire immediately: never unlock or queue an old tick. */
export function playCountdownTick(secondsLeft: number): void {
  if (!Number.isInteger(secondsLeft) || secondsLeft < 1 || secondsLeft > 5)
    return;
  const audio = context;
  const buffer = clockBuffers.get(secondsLeft % 2 === 1 ? "tick" : "tock");
  if (!audio || audio.state !== "running" || document.hidden || !buffer) return;
  try {
    playbackRequest += 1;
    stopVoices();
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    const voice = { source, gain };
    voices.add(voice);
    source.onended = () => release(voice);
    source.buffer = buffer;
    gain.gain.setValueAtTime(0.7, audio.currentTime);
    source.connect(gain);
    gain.connect(audio.destination);
    source.start(audio.currentTime);
    source.stop(audio.currentTime + buffer.duration + 0.01);
  } catch {
    stopVoices();
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
