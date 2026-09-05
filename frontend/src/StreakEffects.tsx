import { CSSProperties } from "react";

import "./StreakEffects.css";

type PreferencesProps = {
  soundEnabled: boolean;
  effectsEnabled: boolean;
  onSoundChange: () => void;
  onEffectsChange: () => void;
};

export function GamePreferences({
  soundEnabled,
  effectsEnabled,
  onSoundChange,
  onEffectsChange,
}: PreferencesProps) {
  return (
    <div
      className="game-preferences"
      role="group"
      aria-label="Game preferences"
    >
      <button
        type="button"
        aria-label="Sound"
        aria-pressed={soundEnabled}
        onClick={onSoundChange}
      >
        <span aria-hidden="true">♪</span> Sound {soundEnabled ? "on" : "off"}
      </button>
      <button
        type="button"
        aria-label="Visual effects"
        aria-pressed={effectsEnabled}
        onClick={onEffectsChange}
      >
        <span aria-hidden="true">✦</span> Effects{" "}
        {effectsEnabled ? "on" : "off"}
      </button>
    </div>
  );
}

export default function StreakEffects({
  streak,
  milestone,
  enabled,
}: {
  streak: number;
  milestone: number | null;
  enabled: boolean;
}) {
  const onFire = streak >= 5;
  const intensity =
    streak >= 15 ? "legendary" : streak >= 10 ? "inferno" : "fire";
  const milestoneTitle =
    milestone && milestone >= 15
      ? "Chat legend"
      : milestone && milestone >= 10
        ? "Unstoppable"
        : "You're on fire";
  return (
    <>
      {onFire && enabled && (
        <div
          className={`streak-fire streak-fire--${intensity}`}
          aria-hidden="true"
        >
          <div className="streak-fire-glow" />
          {Array.from({ length: 14 }, (_, index) => (
            <i
              key={index}
              className="streak-flame"
              style={
                {
                  "--flame-position": `${(index / 13) * 100}%`,
                  "--flame-delay": `${(index % 5) * -0.8}s`,
                  "--flame-height": `${46 + ((index * 17) % 48)}px`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      <div className="streak-panel">
        <div
          className="streak-milestone-slot"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {milestone && (
            <div
              key={milestone}
              className={`streak-milestone ${enabled ? "streak-milestone--animated" : ""}`}
            >
              <span>{milestoneTitle}</span>
              <strong>{milestone} correct in a row</strong>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
