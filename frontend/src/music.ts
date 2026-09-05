import { useCallback, useEffect, useMemo, useRef } from "react";

export type MusicScene = "lobby" | "gameplay" | "silent";

type MusicOptions = {
  enabled: boolean;
  volume: number;
  scene: MusicScene;
  urgent: boolean;
};

const GAMEPLAY_TRACKS = [
  "penguin-town",
  "sanctuary",
  "sketchbook-2025-12-11",
  "sketchbook-2024-10-14",
] as const;
type GameplayTrack = (typeof GAMEPLAY_TRACKS)[number];
type Track = "lobby" | GameplayTrack;
type Voice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  track: Track;
  startedAt: number;
  offset: number;
  duration: number;
};
type Download = {
  controller: AbortController;
  promise: Promise<AudioBuffer | null>;
};
const TRACKS: Record<Track, string> = {
  lobby: "/audio/lobby.mp3",
  "penguin-town": "/audio/gameplay-penguin-town.mp3",
  sanctuary: "/audio/gameplay-sanctuary.mp3",
  "sketchbook-2025-12-11": "/audio/gameplay-sketchbook-2025-12-11.mp3",
  "sketchbook-2024-10-14": "/audio/gameplay-sketchbook-2024-10-14.mp3",
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
  private downloads = new Map<Track, Download>();
  private failed = new Set<Track>();
  private playlist: GameplayTrack[] = [];
  private gameplayTrack: GameplayTrack | null = null;
  private gameplayOffset = 0;
  private lastPlayed: GameplayTrack | null = null;
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
        this.rememberPosition();
        this.request += 1;
        this.abortDownloads();
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
    if (options.enabled && !this.options.enabled) this.failed.clear();
    this.options = options;
    if (changed) this.cancelPlayback(this.canPlay);
    this.updateVolume();
    if (changed && this.canPlay) this.prepare();
  }

  private playCurrent(): void {
    if (!this.canPlay || this.current) return;
    const audio = this.getContext();
    const scene = this.options.scene;
    if (!audio || scene === "silent") return;
    if (scene === "gameplay" && !this.gameplayTrack) {
      this.gameplayTrack = this.nextTrack();
      this.gameplayOffset = 0;
    }
    const track = scene === "lobby" ? "lobby" : this.gameplayTrack;
    if (!track || this.failed.has(track)) return;
    const buffer = this.buffers.get(track);
    if (buffer) {
      if (audio.state === "running") this.start(audio, buffer, track);
      return;
    }
    const request = this.request;
    void this.loadTrack(audio, track).then((decoded) => {
      if (
        request !== this.request ||
        !this.canPlay ||
        scene !== this.options.scene
      )
        return;
      if (decoded) {
        if (audio.state === "running") this.start(audio, decoded, track);
      } else if (track === this.gameplayTrack) {
        this.gameplayTrack = null;
        this.playCurrent();
      }
    });
  }

  private peekNextTrack(): GameplayTrack | null {
    this.playlist = this.playlist.filter((track) => !this.failed.has(track));
    if (!this.playlist.length) {
      this.playlist = GAMEPLAY_TRACKS.filter(
        (track) => !this.failed.has(track),
      );
      for (let index = this.playlist.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        [this.playlist[index], this.playlist[swap]] = [
          this.playlist[swap],
          this.playlist[index],
        ];
      }
      if (this.playlist.length > 1 && this.playlist[0] === this.lastPlayed) {
        [this.playlist[0], this.playlist[1]] = [
          this.playlist[1],
          this.playlist[0],
        ];
      }
    }
    return this.playlist[0] ?? null;
  }

  private nextTrack(): GameplayTrack | null {
    const track = this.peekNextTrack();
    if (track) this.playlist.shift();
    return track;
  }

  private trimBuffers(): void {
    for (const track of this.buffers.keys()) {
      if (
        track !== "lobby" &&
        track !== this.gameplayTrack &&
        track !== this.playlist[0]
      ) {
        this.buffers.delete(track);
      }
    }
  }

  private loadTrack(
    audio: AudioContext,
    track: Track,
  ): Promise<AudioBuffer | null> {
    const existing = this.downloads.get(track);
    if (existing) return existing.promise;
    const cached = this.buffers.get(track);
    if (cached) return Promise.resolve(cached);
    if (this.failed.has(track)) return Promise.resolve(null);
    const controller = new AbortController();
    const request = this.request;
    this.trimBuffers();
    const promise = (async () => {
      try {
        const response = await fetch(TRACKS[track], {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Music unavailable");
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return null;
        const decoded = await audio.decodeAudioData(bytes);
        if (
          controller.signal.aborted ||
          this.disposed ||
          request !== this.request
        )
          return null;
        this.buffers.set(track, decoded);
        return decoded;
      } catch {
        // Try each unavailable track once; an explicit off/on toggle retries it.
        if (!controller.signal.aborted && request === this.request)
          this.failed.add(track);
        return null;
      } finally {
        if (this.downloads.get(track)?.controller === controller)
          this.downloads.delete(track);
      }
    })();
    this.downloads.set(track, { controller, promise });
    return promise;
  }

  private preloadNext(audio: AudioContext): void {
    const track = this.peekNextTrack();
    if (!track) return;
    const request = this.request;
    void this.loadTrack(audio, track).then((buffer) => {
      if (
        !buffer &&
        request === this.request &&
        this.canPlay &&
        this.options.scene === "gameplay"
      ) {
        this.preloadNext(audio);
      }
    });
  }

  private start(audio: AudioContext, buffer: AudioBuffer, track: Track): void {
    if (this.current || !this.master) return;
    const offset = track === "lobby" ? 0 : this.gameplayOffset;
    const remaining = buffer.duration - offset;
    if (track !== "lobby" && remaining <= 0) {
      // The source may finish just before a scene change hides its ended event.
      this.gameplayTrack = null;
      this.gameplayOffset = 0;
      this.playCurrent();
      return;
    }
    let voice: Voice | null = null;
    try {
      voice = {
        source: audio.createBufferSource(),
        gain: audio.createGain(),
        track,
        startedAt: audio.currentTime,
        offset,
        duration: buffer.duration,
      };
      this.voices.set(voice, null);
      const current = voice;
      current.source.buffer = buffer;
      current.source.loop = track === "lobby";
      current.source.connect(current.gain);
      current.gain.connect(this.master);
      current.gain.gain.setValueAtTime(0, audio.currentTime);
      const fade = Math.min(FADE_SECONDS, remaining / 2);
      current.gain.gain.linearRampToValueAtTime(1, audio.currentTime + fade);
      if (track !== "lobby") {
        // Play the whole selection, smoothing its ending into the next track.
        current.gain.gain.setValueAtTime(
          1,
          audio.currentTime + remaining - fade,
        );
        current.gain.gain.linearRampToValueAtTime(
          0,
          audio.currentTime + remaining,
        );
      }
      current.source.onended = () => {
        const advance =
          this.current === current &&
          current.track !== "lobby" &&
          this.canPlay &&
          this.options.scene === "gameplay";
        this.release(current);
        if (advance) {
          this.gameplayTrack = null;
          this.gameplayOffset = 0;
          this.playCurrent();
        }
      };
      current.source.start(0, offset);
      this.current = current;
      this.updateVolume();
      if (track !== "lobby") {
        this.lastPlayed = track;
        this.preloadNext(audio);
      }
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
    const mix = scene === "gameplay" ? (urgent ? 0 : 0.75) : 1;
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
    voice.source.buffer = null;
    voice.gain.disconnect();
    if (this.current === voice) this.current = null;
  }

  private cancelPlayback(fade: boolean): void {
    this.rememberPosition();
    this.request += 1;
    this.abortDownloads();
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

  private rememberPosition(): void {
    const voice = this.current;
    if (!voice || voice.track === "lobby" || !this.audio) return;
    this.gameplayOffset = Math.min(
      voice.duration,
      voice.offset + Math.max(0, this.audio.currentTime - voice.startedAt),
    );
  }

  private abortDownloads(): void {
    for (const { controller } of this.downloads.values()) controller.abort();
    this.downloads.clear();
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
