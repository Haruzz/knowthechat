import { useCallback, useEffect, useMemo, useRef } from "react";

export type MusicScene = "lobby" | "gameplay" | "silent";

type MusicOptions = {
  enabled: boolean;
  volume: number;
  scene: MusicScene;
  urgent: boolean;
};

type Track = Exclude<MusicScene, "silent">;
type Voice = { source: AudioBufferSourceNode; gain: GainNode };
const TRACKS: Record<Track, string> = {
  lobby: "/audio/lobby.mp3",
  gameplay: "/audio/gameplay.mp3",
};
const FADE_SECONDS = 0.4;

/** One player per mounted game; music never changes game state. */
class MusicPlayer {
  private options: MusicOptions = {
    enabled: false,
    volume: 0,
    scene: "silent",
    urgent: false,
  };
  private audio: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<Track, AudioBuffer>();
  private loading: AbortController | null = null;
  private request = 0;
  private disposed = false;
  private hidden = document.hidden;
  private current: Voice | null = null;
  private voices = new Map<Voice, ReturnType<typeof setTimeout> | null>();
  private duckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onVisibility);
    window.addEventListener("pointerdown", this.onGesture);
    window.addEventListener("keydown", this.onGesture);
  }

  private get canPlay(): boolean {
    return (
      !this.disposed &&
      !this.hidden &&
      this.options.enabled &&
      this.options.scene !== "silent"
    );
  }

  private getContext(): AudioContext | null {
    try {
      if (this.audio?.state === "closed") {
        this.request += 1;
        this.loading?.abort();
        this.loading = null;
        for (const voice of this.voices.keys()) this.release(voice);
        this.buffers.clear();
        this.master?.disconnect();
        this.master = null;
        this.audio = null;
      }
      if (!this.audio && typeof window.AudioContext === "function") {
        this.audio = new window.AudioContext();
        this.master = this.audio.createGain();
        this.master.gain.setValueAtTime(0, this.audio.currentTime);
        this.master.connect(this.audio.destination);
      }
      return this.audio;
    } catch {
      return null;
    }
  }

  /** May unlock from the toggle's gesture before React enables music. */
  prepare = (): void => {
    if (this.disposed || this.hidden) return;
    const audio = this.getContext();
    if (!audio) return;
    try {
      // Call resume again on gestures even if an autoplay attempt is pending.
      void audio
        .resume()
        .then(() => {
          if (this.canPlay) this.playCurrent();
          else if (audio.state === "running")
            void audio.suspend().catch(() => {});
        })
        .catch(() => {});
    } catch {
      // Missing devices or playback permission must not interrupt a game.
    }
    if (this.canPlay) this.playCurrent();
  };

  update(options: MusicOptions): void {
    const changed =
      options.enabled !== this.options.enabled ||
      options.scene !== this.options.scene;
    this.options = options;
    if (changed) this.cancelPlayback(this.canPlay);
    this.updateVolume();
    if (changed && this.canPlay) this.prepare();
  }

  private playCurrent(): void {
    if (!this.canPlay || this.current || this.loading) return;
    const audio = this.getContext();
    const scene = this.options.scene;
    if (!audio || scene === "silent") return;
    const buffer = this.buffers.get(scene);
    if (buffer) {
      if (audio.state === "running") this.start(audio, buffer);
      return;
    }
    const controller = new AbortController();
    this.loading = controller;
    const request = this.request;
    void (async () => {
      try {
        const response = await fetch(TRACKS[scene], {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        const decoded = await audio.decodeAudioData(bytes);
        if (controller.signal.aborted || this.disposed) return;
        this.buffers.set(scene, decoded);
        if (
          request === this.request &&
          this.canPlay &&
          audio.state === "running"
        ) {
          this.start(audio, decoded);
        }
      } catch {
        // A missing or undecodable track leaves the game playable and silent.
      } finally {
        if (this.loading === controller) this.loading = null;
      }
    })();
  }

  private start(audio: AudioContext, buffer: AudioBuffer): void {
    if (this.current || !this.master) return;
    let voice: Voice | null = null;
    try {
      voice = { source: audio.createBufferSource(), gain: audio.createGain() };
      this.voices.set(voice, null);
      const current = voice;
      current.source.buffer = buffer;
      current.source.loop = true;
      current.source.connect(current.gain);
      current.gain.connect(this.master);
      current.gain.gain.setValueAtTime(0, audio.currentTime);
      current.gain.gain.linearRampToValueAtTime(
        1,
        audio.currentTime + FADE_SECONDS,
      );
      current.source.onended = () => this.release(current);
      current.source.start();
      this.current = current;
      this.updateVolume();
    } catch {
      if (voice) this.release(voice);
    }
  }

  private updateVolume(): void {
    if (!this.master || !this.audio) return;
    const { volume, scene, urgent } = this.options;
    const level = Number.isFinite(volume)
      ? Math.max(0, Math.min(1, volume))
      : 0;
    const mix = scene === "gameplay" ? 0.75 * (urgent ? 1.12 : 1) : 1;
    const target = this.canPlay ? level * mix * (this.duckTimer ? 0.25 : 1) : 0;
    try {
      // setTargetAtTime follows the current level smoothly, even during a fade.
      this.master.gain.cancelScheduledValues(this.audio.currentTime);
      this.master.gain.setTargetAtTime(target, this.audio.currentTime, 0.08);
    } catch {
      // The browser can close its audio device independently of the page.
    }
  }

  duck = (durationMs = 1700): void => {
    if (!this.canPlay) return;
    if (this.duckTimer) clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(
      () => {
        this.duckTimer = null;
        this.updateVolume();
      },
      Math.max(0, Math.min(10000, durationMs)),
    );
    this.updateVolume();
  };

  private release(voice: Voice): void {
    const timer = this.voices.get(voice);
    if (timer) clearTimeout(timer);
    if (!this.voices.delete(voice)) return;
    voice.source.onended = null;
    try {
      voice.source.stop();
    } catch {
      /* Already stopped. */
    }
    voice.source.disconnect();
    voice.gain.disconnect();
    if (this.current === voice) this.current = null;
  }

  private cancelPlayback(fade: boolean): void {
    this.request += 1;
    this.loading?.abort();
    this.loading = null;
    // A final reveal can change scenes while its celebration is still playing.
    if (!fade) {
      if (this.duckTimer) clearTimeout(this.duckTimer);
      this.duckTimer = null;
    }
    for (const voice of this.voices.keys()) {
      // Only the outgoing current scene may fade; rapid transitions cannot pile up.
      if (fade && voice === this.current && this.audio?.state === "running") {
        try {
          const time = this.audio.currentTime;
          voice.gain.gain.cancelScheduledValues(time);
          voice.gain.gain.setTargetAtTime(0, time, 0.08);
          voice.source.stop(time + FADE_SECONDS);
          this.voices.set(
            voice,
            setTimeout(() => this.release(voice), 500),
          );
        } catch {
          this.release(voice);
        }
      } else this.release(voice);
    }
    this.current = null;
    if (!this.canPlay && this.audio?.state === "running") {
      void this.audio.suspend().catch(() => {});
    }
  }

  private onGesture = (): void => {
    if (this.options.enabled) this.prepare();
  };

  private onVisibility = (): void => {
    this.hidden = document.hidden;
    this.cancelPlayback(false);
    this.updateVolume();
    if (this.canPlay) this.prepare();
  };

  private onPageHide = (): void => {
    this.hidden = true;
    this.cancelPlayback(false);
    this.updateVolume();
  };

  dispose(): void {
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onVisibility);
    window.removeEventListener("pointerdown", this.onGesture);
    window.removeEventListener("keydown", this.onGesture);
    this.cancelPlayback(false);
    this.buffers.clear();
    this.master?.disconnect();
    if (this.audio && this.audio.state !== "closed") {
      void this.audio.close().catch(() => {});
    }
    this.audio = null;
    this.master = null;
  }
}

export function useMusic(options: MusicOptions) {
  const player = useRef<MusicPlayer | null>(null);
  useEffect(() => {
    const mounted = new MusicPlayer();
    player.current = mounted;
    return () => {
      mounted.dispose();
      player.current = null;
    };
  }, []);
  const { enabled, volume, scene, urgent } = options;
  useEffect(() => {
    player.current?.update({ enabled, volume, scene, urgent });
  }, [enabled, volume, scene, urgent]);
  const prepare = useCallback(() => player.current?.prepare(), []);
  const duck = useCallback(
    (durationMs?: number) => player.current?.duck(durationMs),
    [],
  );
  return useMemo(() => ({ prepare, duck }), [prepare, duck]);
}
