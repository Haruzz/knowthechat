import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StreakPreview from "./StreakPreview";
import {
  playApplause,
  playAnswerSound,
  playCountdownTick,
  playStreakSound,
  prepareAudio,
  stopApplause,
  stopAudio,
} from "../src/audio";
import { useMusic } from "../src/music";
const music = vi.hoisted(() => ({ prepare: vi.fn(), duck: vi.fn() }));
vi.mock("../src/music", () => ({
  useMusic: vi.fn(() => music),
}));
vi.mock("../src/audio", () => ({
  prepareAudio: vi.fn().mockResolvedValue(undefined),
  playApplause: vi.fn(),
  playAnswerSound: vi.fn(),
  playCountdownTick: vi.fn(),
  playStreakSound: vi.fn(),
  stopAudio: vi.fn(),
  stopApplause: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("local streak playground", () => {
  it("auditions game-over applause with music silent and respects SFX mute", async () => {
    render(<StreakPreview />);
    const button = screen.getByRole("button", { name: "Game over · applause" });
    await act(async () => fireEvent.click(button));
    expect(playApplause).toHaveBeenCalledOnce();
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "silent",
      urgent: false,
    });
    await act(async () => fireEvent.click(button));
    expect(playApplause).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    expect(stopAudio).toHaveBeenCalledOnce();
    await act(async () => fireEvent.click(button));
    expect(playApplause).toHaveBeenCalledTimes(2);
  });

  it.each(["Gameplay", "Correct guess +1", "Sound effects"])(
    "cancels pending applause when clicking %s",
    async (action) => {
      let ready!: () => void;
      vi.mocked(prepareAudio).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
      );
      render(<StreakPreview />);
      fireEvent.click(
        screen.getByRole("button", { name: "Game over · applause" }),
      );
      expect(playApplause).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: action }));
      await act(async () => ready());
      expect(playApplause).not.toHaveBeenCalled();
      expect(stopApplause).toHaveBeenCalled();
    },
  );

  it("cancels pending applause on unmount", async () => {
    let ready!: () => void;
    vi.mocked(prepareAudio).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const { unmount } = render(<StreakPreview />);
    fireEvent.click(
      screen.getByRole("button", { name: "Game over · applause" }),
    );
    unmount();
    await act(async () => ready());
    expect(playApplause).not.toHaveBeenCalled();
    expect(stopApplause).toHaveBeenCalled();
  });

  it("waits for delayed audio readiness before starting the first countdown second", async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    vi.mocked(prepareAudio).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    render(<StreakPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Final seconds" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.queryByLabelText("Countdown seconds")).toBeNull();
    expect(playCountdownTick).not.toHaveBeenCalled();
    await act(async () => {
      ready();
    });
    expect(screen.getByLabelText("Countdown seconds").textContent).toBe("5");
    expect(playCountdownTick).toHaveBeenCalledExactlyOnceWith(5);
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "gameplay",
      urgent: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(vi.mocked(playCountdownTick).mock.calls).toEqual([[5], [4]]);
  });

  it("cancels an audio unlock in progress when the preview scene changes", async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    vi.mocked(prepareAudio).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    render(<StreakPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Final seconds" }));
    fireEvent.click(screen.getByRole("button", { name: "Gameplay" }));
    await act(async () => {
      ready();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByLabelText("Countdown seconds")).toBeNull();
    expect(playCountdownTick).not.toHaveBeenCalled();
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "gameplay",
      urgent: false,
    });
  });

  it("starts once after the readiness timeout and ignores a later unlock result", async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    vi.mocked(prepareAudio).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    render(<StreakPreview />);
    fireEvent.click(
      screen.getByRole("button", { name: "Try 5-second countdown" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByLabelText("Countdown seconds").textContent).toBe("5");
    expect(playCountdownTick).toHaveBeenCalledExactlyOnceWith(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      ready();
    });
    expect(playCountdownTick).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByLabelText("Countdown seconds").textContent).toBe("4");
    expect(vi.mocked(playCountdownTick).mock.calls).toEqual([[5], [4]]);
  });

  it.each(["Final seconds", "Try 5-second countdown"])(
    "auditions five countdown cues with music off through %s and stops at zero",
    async (button) => {
      vi.useFakeTimers();
      render(<StreakPreview />);
      fireEvent.click(screen.getByRole("button", { name: "Music" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: button }));
      });
      expect(prepareAudio).toHaveBeenCalledOnce();
      expect(screen.getByLabelText("Countdown seconds").textContent).toBe("5");
      expect(playCountdownTick).toHaveBeenCalledExactlyOnceWith(5);
      for (let remaining = 4; remaining >= 0; remaining -= 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(screen.getByLabelText("Countdown seconds").textContent).toBe(
          String(remaining),
        );
      }
      expect(vi.mocked(playCountdownTick).mock.calls).toEqual([
        [5],
        [4],
        [3],
        [2],
        [1],
      ]);
      expect(music.duck).not.toHaveBeenCalled();
      expect(useMusic).toHaveBeenLastCalledWith({
        enabled: false,
        volume: 0.35,
        scene: "silent",
        urgent: false,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(playCountdownTick).toHaveBeenCalledTimes(5);
    },
  );

  it("respects SFX mute and cancels the audition when a guess is made", async () => {
    vi.useFakeTimers();
    render(<StreakPreview />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Try 5-second countdown" }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    expect(
      screen.getByText("SFX is off. Turn it on to hear the countdown."),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(playCountdownTick).toHaveBeenCalledTimes(1);
    expect(music.duck).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Try 5-second countdown" }),
    );
    expect(screen.getByLabelText("Countdown seconds").textContent).toBe("5");
    expect(playCountdownTick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Correct guess +1" }));
    expect(screen.queryByLabelText("Countdown seconds")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Try 5-second countdown" }),
      );
    });
    expect(playCountdownTick).toHaveBeenLastCalledWith(5);
    fireEvent.click(screen.getByRole("button", { name: "Correct guess +1" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(playCountdownTick).toHaveBeenCalledTimes(2);
  });

  it("starts music on and auditions lobby, gameplay and final seconds locally", async () => {
    render(<StreakPreview />);
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "lobby",
      urgent: false,
    });
    expect(music.prepare).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Music" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect(music.prepare).toHaveBeenCalledOnce();
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "lobby",
      urgent: false,
    });

    fireEvent.change(screen.getByRole("slider", { name: "Music volume" }), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Gameplay" }));
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.6,
      scene: "gameplay",
      urgent: false,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Final seconds" }));
    });
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.6,
      scene: "gameplay",
      urgent: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Lobby" }));
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.6,
      scene: "lobby",
      urgent: false,
    });
    expect(
      screen
        .getByRole("button", { name: "Lobby" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: false,
      volume: 0.6,
      scene: "lobby",
      urgent: false,
    });
  });

  it("ducks music only when a milestone jingle is audible", () => {
    render(<StreakPreview />);
    fireEvent.click(screen.getByRole("button", { name: "5 · On fire" }));
    expect(music.duck).toHaveBeenCalledOnce();
    expect(playStreakSound).toHaveBeenCalledExactlyOnceWith(5);

    fireEvent.click(screen.getByRole("button", { name: "Correct guess +1" }));
    expect(playAnswerSound).toHaveBeenCalledExactlyOnceWith(true);
    expect(music.duck).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    fireEvent.click(screen.getByRole("button", { name: "10 · Unstoppable" }));
    expect(music.duck).toHaveBeenCalledOnce();
    expect(playStreakSound).toHaveBeenCalledOnce();
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "lobby",
      urgent: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    fireEvent.click(screen.getByRole("button", { name: "15 · Chat legend" }));
    expect(music.duck).toHaveBeenCalledTimes(2);
  });

  it("previews all tiers and restarts the celebration and dismissal timer on replay", async () => {
    vi.useFakeTimers();
    const { container } = render(<StreakPreview />);
    for (const [button, title, theme] of [
      ["5 · On fire", "You're on fire", "fire"],
      ["10 · Unstoppable", "Unstoppable", "inferno"],
      ["15 · Chat legend", "Chat legend", "legendary"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(screen.getByText(title)).toBeTruthy();
      expect(container.querySelector(`.streak-fire--${theme}`)).toBeTruthy();
    }
    expect(vi.mocked(playStreakSound).mock.calls).toEqual([[5], [10], [15]]);
    const banner = container.querySelector(".streak-milestone");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Replay celebration" }));
    expect(container.querySelector(".streak-milestone")).not.toBe(banner);
    expect(playStreakSound).toHaveBeenLastCalledWith(15);
    expect(playStreakSound).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("Chat legend")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(screen.queryByText("Chat legend")).toBeNull();
    expect(container.querySelector(".streak-fire--legendary")).toBeTruthy();
  });
  it("simulates correct guesses, a miss and optional effects", () => {
    const { container } = render(<StreakPreview />);
    for (let i = 0; i < 4; i++)
      fireEvent.click(screen.getByRole("button", { name: "Correct guess +1" }));
    expect(container.querySelector(".streak-fire")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Correct guess +1" }));
    expect(screen.getByText("You're on fire")).toBeTruthy();
    expect(screen.getByLabelText("Simulated streak").textContent).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Visual effects" }));
    expect(container.querySelector(".streak-fire")).toBeNull();
    expect(screen.getByText("5 correct in a row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Visual effects" }));
    expect(container.querySelector(".streak-fire")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Wrong guess · reset" }),
    );
    expect(screen.getByLabelText("Simulated streak").textContent).toBe("0");
    expect(container.querySelector(".streak-fire")).toBeNull();
    expect(screen.queryByText("5 correct in a row")).toBeNull();
  });
  it("mutes milestone and guess sounds independently of visual effects", () => {
    render(<StreakPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Visual effects" }));
    fireEvent.click(screen.getByRole("button", { name: "5 · On fire" }));
    expect(playStreakSound).toHaveBeenCalledExactlyOnceWith(5);
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    expect(stopAudio).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "10 · Unstoppable" }));
    fireEvent.click(screen.getByRole("button", { name: "Correct guess +1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Wrong guess · reset" }),
    );
    expect(playStreakSound).toHaveBeenCalledOnce();
    expect(playAnswerSound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    fireEvent.click(screen.getByRole("button", { name: "15 · Chat legend" }));
    expect(playStreakSound).toHaveBeenLastCalledWith(15);
    expect(document.querySelector(".streak-fire")).toBeNull();
    expect(screen.getByText("Chat legend")).toBeTruthy();
  });
});
