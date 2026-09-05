import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StreakPreview from "./StreakPreview";
import { playAnswerSound, playStreakSound, stopAudio } from "../src/audio";
import { useMusic } from "../src/music";
const music = vi.hoisted(() => ({ prepare: vi.fn(), duck: vi.fn() }));
vi.mock("../src/music", () => ({
  useMusic: vi.fn(() => music),
}));
vi.mock("../src/audio", () => ({
  prepareAudio: vi.fn(),
  playAnswerSound: vi.fn(),
  playStreakSound: vi.fn(),
  stopAudio: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("local streak playground", () => {
  it("starts music off and auditions lobby, gameplay and final seconds locally", () => {
    render(<StreakPreview />);
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: false,
      volume: 0.35,
      scene: "lobby",
      urgent: false,
    });
    expect(music.prepare).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Music" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

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
    fireEvent.click(screen.getByRole("button", { name: "Final seconds" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
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
