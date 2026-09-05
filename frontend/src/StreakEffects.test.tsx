import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StreakEffects, { GamePreferences } from "./StreakEffects";

afterEach(cleanup);

describe("Game preferences", () => {
  it("keeps music, sound effects and visual effects independently controllable", () => {
    const onMusicChange = vi.fn();
    const onSoundChange = vi.fn();
    const onEffectsChange = vi.fn();
    render(
      <GamePreferences
        soundEnabled
        effectsEnabled
        musicEnabled={false}
        onMusicChange={onMusicChange}
        onSoundChange={onSoundChange}
        onEffectsChange={onEffectsChange}
      />,
    );

    const music = screen.getByRole("button", { name: "Music" });
    expect(music.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("slider", { name: "Music volume" })).toBeNull();
    fireEvent.click(music);
    expect(onMusicChange).toHaveBeenCalledOnce();
    expect(onSoundChange).not.toHaveBeenCalled();
    expect(onEffectsChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    expect(onSoundChange).toHaveBeenCalledOnce();
    expect(onMusicChange).toHaveBeenCalledOnce();
    expect(onEffectsChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Visual effects" }));
    expect(onEffectsChange).toHaveBeenCalledOnce();
  });

  it("exposes an accessible music volume slider and percentage while music is on", () => {
    const onMusicVolumeChange = vi.fn();
    const props = {
      soundEnabled: false,
      effectsEnabled: true,
      musicEnabled: true,
      musicVolume: 0.35,
      onMusicChange: vi.fn(),
      onMusicVolumeChange,
      onSoundChange: vi.fn(),
      onEffectsChange: vi.fn(),
    };
    const { rerender } = render(<GamePreferences {...props} />);

    const slider = screen.getByRole("slider", { name: "Music volume" });
    expect(slider.getAttribute("aria-valuetext")).toBe("35%");
    expect(screen.getByText("35%")).toBeTruthy();
    fireEvent.change(slider, { target: { value: "60" } });
    expect(onMusicVolumeChange).toHaveBeenCalledExactlyOnceWith(0.6);
    expect(props.onSoundChange).not.toHaveBeenCalled();

    rerender(<GamePreferences {...props} musicVolume={0.6} />);
    expect(slider.getAttribute("aria-valuetext")).toBe("60%");
    expect(screen.getByText("60%")).toBeTruthy();

    rerender(<GamePreferences {...props} musicEnabled={false} />);
    expect(screen.queryByRole("slider", { name: "Music volume" })).toBeNull();
  });

  it("keeps the streak preview's existing preferences without requiring music controls", () => {
    render(
      <GamePreferences
        soundEnabled={false}
        effectsEnabled
        onSoundChange={vi.fn()}
        onEffectsChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Music" })).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Sound effects" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Visual effects" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("Streak effects", () => {
  it("tracks streaks silently before ignition", () => {
    const { container } = render(
      <StreakEffects streak={3} milestone={null} enabled />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByLabelText(/Current streak/)).toBeNull();
    expect(document.querySelector(".streak-fire")).toBeNull();
  });

  it("celebrates a legendary streak while keeping the decoration hidden from assistive technology", () => {
    render(<StreakEffects streak={15} milestone={15} enabled />);
    expect(screen.getByRole("status").textContent).toBe(
      "Chat legend15 correct in a row",
    );
    expect(
      document
        .querySelector(".streak-fire--legendary")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("retains only the milestone without animated effects", () => {
    render(<StreakEffects streak={5} milestone={5} enabled={false} />);
    expect(screen.queryByLabelText(/Current streak/)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "5 correct in a row",
    );
    expect(document.querySelector(".streak-fire")).toBeNull();
    expect(document.querySelector(".streak-milestone--animated")).toBeNull();
  });
});
