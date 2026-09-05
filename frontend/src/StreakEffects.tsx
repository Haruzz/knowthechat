import { CSSProperties } from "react";

import "./StreakEffects.css";

type PreferencesProps = {
  soundEnabled: boolean;
  effectsEnabled: boolean;
  onSoundChange: () => void;
  onEffectsChange: () => void;
  musicEnabled?: boolean;
  musicVolume?: number;
  onMusicChange?: () => void;
  onMusicVolumeChange?: (volume: number) => void;
};

export function GamePreferences({
  soundEnabled,
  effectsEnabled,
  onSoundChange,
  onEffectsChange,
  musicEnabled,
  musicVolume = 0.35,
  onMusicChange,
  onMusicVolumeChange,
}: PreferencesProps) {
  const volumePercent = Math.round(musicVolume * 100);
  return (
    <div
      className="game-preferences"
      role="group"
      aria-label="Game preferences"
    >
      {musicEnabled !== undefined && onMusicChange && (
        <div className="game-music-preferences">
          <button
            type="button"
            aria-label="Music"
            aria-pressed={musicEnabled}
            onClick={onMusicChange}
          >
            <span aria-hidden="true">♫</span> Music{" "}
            {musicEnabled ? "on" : "off"}
          </button>
          {musicEnabled && onMusicVolumeChange && (
            <label className="game-music-volume">
              <span>Volume</span>
              <input
                type="range"
                aria-label="Music volume"
                aria-valuetext={`${volumePercent}%`}
                min="0"
                max="100"
                step="1"
                value={volumePercent}
                onChange={(event) =>
                  onMusicVolumeChange(Number(event.currentTarget.value) / 100)
                }
              />
              <span className="game-music-volume-value" aria-hidden="true">
                {volumePercent}%
              </span>
            </label>
          )}
        </div>
      )}
      <button
        type="button"
        aria-label="Sound effects"
        aria-pressed={soundEnabled}
        onClick={onSoundChange}
      >
        <span aria-hidden="true">♪</span> SFX {soundEnabled ? "on" : "off"}
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
