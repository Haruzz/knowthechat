import { useEffect, useRef, useState } from "react";

import StreakEffects, { GamePreferences } from "../src/StreakEffects";
import {
  playAnswerSound,
  playStreakSound,
  prepareAudio,
  stopAudio,
} from "../src/audio";
import "./StreakPreview.css";

export default function StreakPreview() {
  const [streak, setStreak] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [effectsEnabled, setEffectsEnabled] = useState(true);
  const [celebration, setCelebration] = useState<{
    count: number;
    sequence: number;
  } | null>(null);
  const sequence = useRef(0);

  function celebrate(count: number) {
    setCelebration({ count, sequence: ++sequence.current });
    if (soundEnabled) playStreakSound(count);
  }
  function jumpTo(count: number) {
    setStreak(count);
    celebrate(count);
  }
  function correct() {
    const next = streak + 1;
    setStreak(next);
    if (next % 5 === 0) celebrate(next);
    else if (soundEnabled) playAnswerSound(true);
  }
  function wrong() {
    if (soundEnabled) playAnswerSound(false);
    setStreak(0);
    setCelebration(null);
  }
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
            onSoundChange={() => {
              if (soundEnabled) stopAudio();
              else prepareAudio();
              setSoundEnabled(!soundEnabled);
            }}
            onEffectsChange={() => setEffectsEnabled(!effectsEnabled)}
          />
          <p className="preview-note">
            This playground uses a sample clue and does not change your game
            scores. Your device’s reduced-motion preference still applies.
          </p>
        </section>
      </div>
    </main>
  );
}
