import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import * as PartyGameModule from "./PartyGame";
import { useMusic } from "./music";
import {
  playAnswerSound,
  playCountdownTick,
  playStreakSound,
  playTimeUpSound,
  prepareAudio,
  stopAudio,
} from "./audio";
vi.mock("./audio", () => ({
  prepareAudio: vi.fn(),
  playAnswerSound: vi.fn(),
  playCountdownTick: vi.fn(),
  playStreakSound: vi.fn(),
  playTimeUpSound: vi.fn(),
  stopAudio: vi.fn(),
}));
vi.mock("./music", () => ({ useMusic: vi.fn() }));
const musicPlayback = { prepare: vi.fn(), duck: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useMusic).mockReturnValue(musicPlayback);
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function startGame(roundCount = 16) {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const chatters = ["Alice", "Bob", "Carol"].map((name, index) => ({
    id: String(index),
    name,
    avatar: "",
    messages: 10,
    sub: false,
    vip: false,
    mod: false,
    score: 10,
    activeDays: 3,
    activeMonths: 1,
    avgWords: 5 + index,
  }));
  const quotes = Array.from({ length: roundCount }, (_, index) => ({
    id: `quote-${index}`,
    author: chatters[index % 3].name,
    text: `Clue from ${chatters[index % 3].name}: message ${index}`,
    emotes: [],
    sentAt: 1_700_000_000_000 + index,
    quality: 5,
    difficulty: "medium",
  }));
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input) =>
      new Response(
        JSON.stringify(
          String(input) === "/api/public-archive"
            ? { channel: "example", roomId: "", chatters, quotes, range: null }
            : [],
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  render(<App />);
  fireEvent.change(screen.getByLabelText("Twitch channel"), {
    target: { value: "Example" },
  });
  fireEvent.click(screen.getByRole("button", { name: /open the case/i }));
  await screen.findByLabelText(`Question 1 of ${roundCount}, score 0 of 0`);
}

function correctChoice() {
  const author = screen
    .getByText(/Clue from/)
    .textContent?.match(/Clue from (Alice|Bob|Carol)/)?.[1];
  if (!author) throw new Error("Missing clue author in the fixture");
  return screen.getByRole("button", { name: author });
}

describe("Who Said It frontend", () => {
  it("uses the time-up cue only for unanswered timeouts and preserves ordinary answer and milestone sounds", () => {
    vi.spyOn(PartyGameModule, "default").mockImplementation(
      ({ preferences, onRoundRevealed }) => (
        <>
          {preferences}
          <button onClick={() => onRoundRevealed?.(false, 0, true)}>
            Timed out
          </button>
          <button onClick={() => onRoundRevealed?.(false, 0)}>
            Wrong answer
          </button>
          <button onClick={() => onRoundRevealed?.(true, 5)}>
            Milestone answer
          </button>
        </>
      ),
    );
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));
    fireEvent.click(screen.getByRole("button", { name: "Timed out" }));
    expect(playTimeUpSound).toHaveBeenCalledOnce();
    expect(playAnswerSound).not.toHaveBeenCalled();
    expect(playStreakSound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Wrong answer" }));
    expect(playAnswerSound).toHaveBeenCalledExactlyOnceWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Milestone answer" }));
    expect(playStreakSound).toHaveBeenCalledExactlyOnceWith(5);
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    fireEvent.click(screen.getByRole("button", { name: "Timed out" }));
    expect(playTimeUpSound).toHaveBeenCalledOnce();
  });

  it("gates multiplayer countdown ticks with sound effects independently of music", () => {
    vi.spyOn(PartyGameModule, "default").mockImplementation(
      ({ preferences, onCountdownTick }) => (
        <>
          {preferences}
          <button onClick={() => onCountdownTick?.(5)}>Countdown cue</button>
        </>
      ),
    );
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));
    fireEvent.click(screen.getByRole("button", { name: "Countdown cue" }));
    expect(playCountdownTick).toHaveBeenCalledExactlyOnceWith(5);
    expect(musicPlayback.duck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    fireEvent.click(screen.getByRole("button", { name: "Countdown cue" }));
    expect(playCountdownTick).toHaveBeenCalledOnce();
    expect(musicPlayback.duck).not.toHaveBeenCalled();
    expect(stopAudio).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    fireEvent.click(screen.getByRole("button", { name: "Countdown cue" }));
    expect(playCountdownTick).toHaveBeenCalledTimes(2);
    expect(musicPlayback.duck).not.toHaveBeenCalled();
  });

  it("starts music on and remembers music and volume independently from sound effects across modes", () => {
    render(<App />);
    expect(
      screen
        .getByRole("button", { name: "Music" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      (screen.getByRole("slider", { name: "Music volume" }) as HTMLInputElement)
        .value,
    ).toBe("35");
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "lobby",
      urgent: false,
    });
    expect(musicPlayback.prepare).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect(screen.queryByRole("slider", { name: "Music volume" })).toBeNull();
    expect(musicPlayback.prepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect(musicPlayback.prepare).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("slider", { name: "Music volume" }), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.12,
      scene: "lobby",
      urgent: false,
    });
    expect(localStorage.getItem("knowthechat-music")).toBe("true");
    expect(localStorage.getItem("knowthechat-music-volume")).toBe("0.12");
    expect(localStorage.getItem("knowthechat-sound")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));
    expect(
      screen
        .getByRole("button", { name: "Music" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      (screen.getByRole("slider", { name: "Music volume" }) as HTMLInputElement)
        .value,
    ).toBe("12");
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect(localStorage.getItem("knowthechat-music")).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Sound effects" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    cleanup();
    render(<App />);
    expect(
      screen
        .getByRole("button", { name: "Music" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect(
      (screen.getByRole("slider", { name: "Music volume" }) as HTMLInputElement)
        .value,
    ).toBe("12");
  });

  it.each(["", "loud", "-1", "2", "Infinity"])(
    "defaults music on and ignores invalid saved music volume %j",
    (value) => {
      localStorage.setItem("knowthechat-music-volume", value);
      localStorage.setItem("knowthechat-music", "unexpected");
      render(<App />);
      expect(useMusic).toHaveBeenLastCalledWith({
        enabled: true,
        volume: 0.35,
        scene: "lobby",
        urgent: false,
      });
    },
  );

  it("restores a saved zero volume without replacing it with the default", () => {
    localStorage.setItem("knowthechat-music-volume", "0");
    localStorage.setItem("knowthechat-music", "true");
    render(<App />);
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0,
      scene: "lobby",
      urgent: false,
    });
    expect(musicPlayback.prepare).not.toHaveBeenCalled();
  });

  it("silences solo results and restores lobby music after returning to setup", async () => {
    localStorage.setItem("knowthechat-music", "true");
    await startGame(3);
    expect(musicPlayback.prepare).toHaveBeenCalledOnce();
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "gameplay",
      urgent: false,
    });
    for (let index = 0; index < 3; index++) {
      fireEvent.click(correctChoice());
      fireEvent.click(
        screen.getByRole("button", { name: /next message|see results/i }),
      );
    }
    expect(screen.getByRole("heading", { name: "3 / 3" })).toBeTruthy();
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "silent",
      urgent: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: false,
      volume: 0.35,
      scene: "silent",
      urgent: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Try another channel" }),
    );
    expect(useMusic).toHaveBeenLastCalledWith({
      enabled: true,
      volume: 0.35,
      scene: "lobby",
      urgent: false,
    });
  });

  it("ignores the old playground query in the normal game", () => {
    window.history.replaceState({}, "", "/?preview=streaks");
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /how well do you know/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Streak playground" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Preview streak effects" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /5 .* On fire/ })).toBeNull();
  });

  it("opens the friends lobby from the game mode picker and returns to solo", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));
    expect(
      screen.getByRole("heading", { name: /friendly rivalry/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /back to solo/i }));
    expect(
      screen.getByRole("heading", { name: /how well do you know/i }),
    ).toBeTruthy();
  });

  it("opens an invite directly in the join form", () => {
    window.history.replaceState({}, "", "/?room=ABC234");
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /friendly rivalry/i }),
    ).toBeTruthy();
    expect((screen.getByLabelText("Room code") as HTMLInputElement).value).toBe(
      "ABC234",
    );
  });

  it("renders the setup surface", () => {
    const currentYear = new Date().getUTCFullYear();
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /how well do you know/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Twitch channel")).toBeTruthy();
    expect(
      (screen.getByLabelText("Archive period") as HTMLSelectElement).value,
    ).toBe(`year:${currentYear}`);
    expect(screen.getByRole("button", { name: /open the case/i })).toBeTruthy();
    const logo = screen.getByRole("img", { name: "Who Said It?" });
    expect(logo.getAttribute("src")).toBe("/logo.png");
    expect(screen.getByRole("main").getAttribute("translate")).toBe("no");
    expect(
      screen.getByRole("link", { name: "Haruzzz on Twitch" }),
    ).toBeTruthy();
    const repositoryLink = screen.getByRole("link", {
      name: "Know The Chat source code on GitHub",
    });
    expect(repositoryLink.getAttribute("href")).toBe(
      "https://github.com/Haruzz/knowthechat",
    );
    expect(
      screen.getByRole("link", { name: "Privacy" }).getAttribute("href"),
    ).toBe("/privacy");
  });

  it("issues the same-origin public archive request", async () => {
    render(<App />);
    const currentYear = new Date().getUTCFullYear();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (String(input) === "/api/public-archive") {
          return new Response(
            JSON.stringify({
              channel: "example",
              roomId: "99",
              total: 0,
              chatters: [],
              quotes: [],
              range: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "Example" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open the case/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/public-archive",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            channel: "example",
            archiveYear: currentYear,
            chatterPool: 50,
          }),
        }),
      );
    });
  });

  it("shows an unavailable calendar year without starting a game", async () => {
    render(<App />);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/public-archive") {
        return new Response(
          JSON.stringify({ error: "No public archive is available for 2023." }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "Example" },
    });
    fireEvent.change(screen.getByLabelText("Archive period"), {
      target: { value: "year:2023" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open the case/i }));

    expect(
      await screen.findByText("No public archive is available for 2023."),
    ).toBeTruthy();
  });

  it("opens the game without waiting for the optional profile lookup", async () => {
    render(<App />);
    const chatters = ["Alice", "Bob", "Carol"].map((name, index) => ({
      id: String(index),
      name,
      avatar: name.slice(0, 2),
      messages: 10,
      sub: false,
      vip: false,
      mod: false,
      score: 10,
      activeDays: 3,
      activeMonths: 1,
      avgWords: 5 + index,
    }));
    const quotes = chatters.map((chatter, index) => ({
      id: `quote-${index}`,
      author: chatter.name,
      text: `Distinctive message number ${index}`,
      emotes: [],
      sentAt: 1_700_000_000_000 + index,
      quality: 5,
      difficulty: "medium",
    }));

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("https://api.ivr.fi/"))
        return new Promise<Response>(() => {});
      if (url === "/api/public-archive")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              channel: "example",
              roomId: "",
              total: quotes.length,
              chatters,
              quotes,
              range: {
                oldest: Date.UTC(2026, 0, 25),
                newest: Date.UTC(2026, 7, 24),
              },
              source: "recent",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "Example" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open the case/i }));

    expect(
      await screen.findByLabelText("Question 1 of 3, score 0 of 0", undefined, {
        timeout: 2_000,
      }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Available chat period: Jan 25 – Aug 24, 2026"),
    ).toBeTruthy();
    expect(screen.getByText("Chats from Jan 25 – Aug 24, 2026")).toBeTruthy();
    expect(screen.getByLabelText("Game progress")).toBeTruthy();
    expect(screen.getByText("Correct")).toBeTruthy();

    const firstQuote = screen.getByText(/Distinctive message number/i);
    const firstMessage = firstQuote.textContent;
    fireEvent.click(
      screen.getAllByRole("button", { name: /Alice|Bob|Carol/i })[0],
    );
    expect(screen.queryByText(/That’s right\.|That was /)).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: /next message/i }),
    );

    const nextQuote = screen.getByText(/Distinctive message number/i);
    expect(nextQuote).not.toBe(firstQuote);
    expect(nextQuote.textContent).not.toBe(firstMessage);
    expect(screen.getByRole("main").getAttribute("translate")).toBe("no");
  });

  it("ignites at five, upgrades at ten, and preserves the best streak after a miss", async () => {
    await startGame();
    for (let question = 1; question <= 16; question++) {
      if (question === 6) {
        const correctButton = correctChoice();
        fireEvent.click(
          screen
            .getAllByRole("button")
            .find(
              (button) =>
                button !== correctButton &&
                /^(Alice|Bob|Carol)$/.test(
                  button.textContent
                    ?.replace(/^[A-Z]{2}/, "")
                    .replace(/[123]$/, "") ?? "",
                ),
            )!,
        );
        expect(screen.queryByLabelText(/Current streak/)).toBeNull();
        expect(document.querySelector(".streak-fire")).toBeNull();
      } else {
        const choice = correctChoice();
        if (question % 2 === 0) {
          fireEvent.keyDown(window, {
            key: choice.querySelector(".choice-key")?.textContent,
          });
        } else {
          fireEvent.click(choice);
        }
        if (question === 4)
          expect(document.querySelector(".streak-fire")).toBeNull();
        if (question === 5) {
          expect(screen.getByText("You're on fire")).toBeTruthy();
          expect(screen.getByText("5 correct in a row")).toBeTruthy();
          expect(document.querySelector(".streak-fire")).toBeTruthy();
        }
        if (question === 16) {
          expect(screen.getByText("Unstoppable")).toBeTruthy();
          expect(document.querySelector(".streak-fire--inferno")).toBeTruthy();
        }
      }
      fireEvent.click(
        screen.getByRole("button", { name: /next message|see results/i }),
      );
    }
    expect(screen.getByRole("heading", { name: "15 / 16" })).toBeTruthy();
    expect(screen.getByText("94%")).toBeTruthy();
    expect(
      screen.getByText("Best streak").nextElementSibling?.textContent,
    ).toBe("10");
    fireEvent.click(
      screen.getByRole("button", { name: "Try another channel" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /open the case/i }));
    expect(
      await screen.findByLabelText("Question 1 of 16, score 0 of 0"),
    ).toBeTruthy();
  });

  it("plays each milestone jingle once instead of the normal answer sound", async () => {
    await startGame(15);
    expect(prepareAudio).toHaveBeenCalledOnce();
    for (let count = 1; count <= 15; count++) {
      const choice = correctChoice();
      fireEvent.click(choice);
      fireEvent.click(choice);
      if (count < 15)
        fireEvent.click(screen.getByRole("button", { name: /next message/i }));
    }
    expect(vi.mocked(playStreakSound).mock.calls).toEqual([[5], [10], [15]]);
    expect(playAnswerSound).toHaveBeenCalledTimes(12);
    expect(musicPlayback.duck).toHaveBeenCalledTimes(3);
    expect(musicPlayback.duck).toHaveBeenLastCalledWith(1_800);
    expect(screen.getByText("Chat legend")).toBeTruthy();
  });

  it("uses one answer path and ignores editable targets, key repeats, and native button activation", async () => {
    await startGame(3);
    render(
      <>
        <input aria-label="Other input" />
        <select aria-label="Other select">
          <option>1</option>
        </select>
        <div contentEditable data-testid="editable" />
      </>,
    );
    const choice = correctChoice();
    const key = choice.querySelector(".choice-key")?.textContent;
    fireEvent.keyDown(screen.getByLabelText("Other input"), { key });
    fireEvent.keyDown(screen.getByLabelText("Other select"), { key });
    fireEvent.keyDown(screen.getByTestId("editable"), { key });
    fireEvent.keyDown(window, { key, repeat: true });
    fireEvent.keyDown(window, { key, ctrlKey: true });
    fireEvent.keyDown(window, { key, altKey: true });
    fireEvent.keyDown(window, { key, metaKey: true });
    expect(screen.getByLabelText("Question 1 of 3, score 0 of 0")).toBeTruthy();
    fireEvent.keyDown(window, { key });
    fireEvent.click(choice);
    expect(screen.getByLabelText("Question 1 of 3, score 1 of 1")).toBeTruthy();
    expect(screen.getByLabelText("Question 1 of 3, score 1 of 1")).toBeTruthy();
    const nextButton = screen.getByRole("button", { name: /next message/i });
    fireEvent.keyDown(nextButton, { key: "Enter" });
    expect(screen.getByLabelText("Question 1 of 3, score 1 of 1")).toBeTruthy();
    fireEvent.click(nextButton);
    expect(screen.getByLabelText("Question 2 of 3, score 1 of 1")).toBeTruthy();
    fireEvent.click(correctChoice());
    fireEvent.keyDown(window, { key: " ", repeat: true });
    expect(screen.getByLabelText("Question 2 of 3, score 2 of 2")).toBeTruthy();
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByLabelText("Question 3 of 3, score 2 of 2")).toBeTruthy();
  });

  it("persists sound and effects controls and allows effects to be disabled mid-streak", async () => {
    await startGame(6);
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    for (let count = 1; count <= 5; count++) {
      fireEvent.click(correctChoice());
      if (count < 5)
        fireEvent.click(screen.getByRole("button", { name: /next message/i }));
    }
    expect(document.querySelector(".streak-fire")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Visual effects" }));
    expect(document.querySelector(".streak-fire")).toBeNull();
    expect(screen.getByLabelText("Question 5 of 6, score 5 of 5")).toBeTruthy();
    expect(localStorage.getItem("knowthechat-sound")).toBe("false");
    expect(stopAudio).toHaveBeenCalledOnce();
    expect(playAnswerSound).not.toHaveBeenCalled();
    expect(playStreakSound).not.toHaveBeenCalled();
    expect(musicPlayback.duck).not.toHaveBeenCalled();
    expect(localStorage.getItem("knowthechat-effects")).toBe("false");
    cleanup();
    render(<App />);
    expect(
      screen
        .getByRole("button", { name: "Sound effects" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Visual effects" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("starts and plays when local history is malformed or storage writes fail", async () => {
    localStorage.setItem("knowthechat-seen:example", '{"unexpected":"object"}');
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    await startGame(3);
    fireEvent.click(screen.getByRole("button", { name: "Sound effects" }));
    expect(
      screen
        .getByRole("button", { name: "Sound effects" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(correctChoice());
    expect(screen.getByLabelText("Question 1 of 3, score 1 of 1")).toBeTruthy();
  });

  it("recovers from archive network failures with a retryable error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "Example" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open the case/i }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Could not load the archive. Check your connection and try again.",
    );
    expect(screen.getByRole("button", { name: /open the case/i })).toBeTruthy();
  });
});
