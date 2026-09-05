import { useEffect, useRef, useState } from "react";

import StreakEffects, { GamePreferences } from "../src/StreakEffects";
import {
  playAnswerSound,
  playCountdownTick,
  playStreakSound,
  playTimeUpSound,
  prepareAudio,
  stopAudio,
} from "../src/audio";
import { useMusic } from "../src/music";
import { useCountdownTicks } from "../src/useCountdownTicks";
import "./StreakPreview.css";

export default function StreakPreview() {
  const [streak, setStreak] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [effectsEnabled, setEffectsEnabled] = useState(true);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [musicVolume, setMusicVolume] = useState(0.35);
  const [countdown, setCountdown] = useState<{
    id: number;
    deadline: number;
  } | null>(null);
  const [countdownNow, setCountdownNow] = useState(Date.now);
  const countdownSequence = useRef(0);
  const countdownStartTimer = useRef<number | undefined>(undefined);
  const countdownSeconds = countdown
    ? Math.max(0, Math.ceil((countdown.deadline - countdownNow) / 1_000))
    : 0;
  useCountdownTicks({
    roundId: countdown ? `preview-${countdown.id}` : null,
    deadline: countdown?.deadline ?? null,
    enabled: soundEnabled && countdown !== null,
    onTick: playCountdownTick,
    onComplete: playTimeUpSound,
    playOnStart: true,
  });
  const [musicPreview, setMusicPreview] = useState<
    "lobby" | "gameplay" | "urgent"
  >("lobby");
  const music = useMusic({
    enabled: musicEnabled,
    volume: musicVolume,
    scene:
      musicPreview === "urgent" && countdown && countdownSeconds === 0
        ? "silent"
        : musicPreview === "lobby"
          ? "lobby"
          : "gameplay",
    urgent: musicPreview === "urgent" && (!countdown || countdownSeconds > 0),
  });
  const [celebration, setCelebration] = useState<{
    count: number;
    sequence: number;
  } | null>(null);
  const sequence = useRef(0);

  function cancelCountdown() {
    countdownSequence.current += 1;
    window.clearTimeout(countdownStartTimer.current);
    setCountdown(null);
  }
  function startCountdown() {
    cancelCountdown();
    const request = countdownSequence.current;
    if (musicEnabled) music.prepare();
    setMusicPreview("urgent");
    let started = false;
    const begin = () => {
      if (started || request !== countdownSequence.current) return;
      started = true;
      window.clearTimeout(countdownStartTimer.current);
      const currentTime = Date.now();
      setCountdownNow(currentTime);
      setCountdown({ id: request, deadline: currentTime + 5_000 });
    };
    if (soundEnabled) {
      // Give the gesture time to unlock audio without freezing a blocked preview.
      countdownStartTimer.current = window.setTimeout(begin, 250);
      void Promise.resolve(prepareAudio()).then(begin);
    } else begin();
  }
  function celebrate(count: number) {
    cancelCountdown();
    setCelebration({ count, sequence: ++sequence.current });
    if (soundEnabled) {
      music.duck();
      playStreakSound(count);
    }
  }
  function jumpTo(count: number) {
    setStreak(count);
    celebrate(count);
  }
  function correct() {
    cancelCountdown();
    const next = streak + 1;
    setStreak(next);
    if (next % 5 === 0) celebrate(next);
    else if (soundEnabled) playAnswerSound(true);
  }
  function wrong() {
    cancelCountdown();
    if (soundEnabled) playAnswerSound(false);
    setStreak(0);
    setCelebration(null);
  }
  useEffect(() => {
    return () => {
      countdownSequence.current += 1;
      window.clearTimeout(countdownStartTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!countdown) return;
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setCountdownNow(currentTime);
      if (currentTime >= countdown.deadline) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [countdown]);
  useEffect(() => {
    if (!celebration) return;
    const timer = window.setTimeout(() => setCelebration(null), 3_500);
    return () => window.clearTimeout(timer);
  }, [celebration]);

  return (
    <main className="game-shell streak-preview" translate="no">
      <header className="streak-preview-header">
        <div>
          <p className="eyebrow">TRY THE EFFECTS</p>
          <h1>Streak playground</h1>
        </div>
      </header>
      <div className="streak-preview-stage">
        <StreakEffects
          key={celebration?.sequence ?? "idle"}
          streak={streak}
          milestone={celebration?.count ?? null}
          enabled={effectsEnabled}
        />
        <section className="game-card">
          <p className="message-meta">
            <span className="difficulty medium">medium</span>
          </p>
          <blockquote>“I have a theory and absolutely no evidence.”</blockquote>
        </section>
        <section
          className="preview-controls"
          aria-label="Streak preview controls"
        >
          <p>Jump to a milestone. No Twitch knowledge required.</p>
          <div className="preview-tiers">
            <button onClick={() => jumpTo(5)}>5 · On fire</button>
            <button onClick={() => jumpTo(10)}>10 · Unstoppable</button>
            <button onClick={() => jumpTo(15)}>15 · Chat legend</button>
          </div>
          <div className="preview-actions">
            <button className="preview-secondary" onClick={correct}>
              Correct guess +1
            </button>
            <button className="preview-secondary" onClick={wrong}>
              Wrong guess · reset
            </button>
            <button
              className="preview-secondary"
              disabled={streak < 5}
              onClick={() => celebrate(streak)}
            >
              Replay celebration
            </button>
          </div>
          <p className="preview-count">
            Simulated streak:{" "}
            <output aria-label="Simulated streak">{streak}</output>
          </p>
          <GamePreferences
            soundEnabled={soundEnabled}
            effectsEnabled={effectsEnabled}
            musicEnabled={musicEnabled}
            musicVolume={musicVolume}
            onMusicChange={() => {
              if (!musicEnabled) music.prepare();
              setMusicEnabled(!musicEnabled);
            }}
            onMusicVolumeChange={(volume) => {
              if (musicEnabled) music.prepare();
              setMusicVolume(volume);
            }}
            onSoundChange={() => {
              if (soundEnabled) stopAudio();
              else prepareAudio();
              setSoundEnabled(!soundEnabled);
            }}
            onEffectsChange={() => setEffectsEnabled(!effectsEnabled)}
          />
          <p className="preview-note">
            Choose a music scene or try a milestone. Final seconds starts the
            five-second tick-tock countdown, ending with a time-up ding.
          </p>
          <div
            className="game-preferences"
            role="group"
            aria-label="Music preview scene"
          >
            {(
              [
                ["lobby", "Lobby"],
                ["gameplay", "Gameplay"],
                ["urgent", "Final seconds"],
              ] as const
            ).map(([scene, label]) => (
              <button
                key={scene}
                type="button"
                aria-pressed={musicPreview === scene}
                onClick={() => {
                  if (scene === "urgent") {
                    startCountdown();
                    return;
                  }
                  cancelCountdown();
                  if (musicEnabled) music.prepare();
                  setMusicPreview(scene);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="preview-actions">
            <button
              type="button"
              className="preview-secondary"
              onClick={startCountdown}
            >
              Try 5-second countdown
            </button>
            {countdown && (
              <span className="preview-countdown">
                <output aria-label="Countdown seconds">
                  {countdownSeconds}
                </output>
                <span>
                  {countdownSeconds > 0 ? "seconds left" : "Time’s up"}
                </span>
              </span>
            )}
          </div>
          <p className="preview-note">
            {soundEnabled
              ? "The countdown uses SFX. Try a guess or celebration to stop it early."
              : "SFX is off. Turn it on to hear the countdown."}
          </p>
          <p className="preview-note">
            This playground uses a sample clue and does not change your game
            scores. Your device’s reduced-motion preference still applies.
          </p>
        </section>
      </div>
    </main>
  );
}
