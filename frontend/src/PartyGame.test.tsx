import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PartyGame from "./PartyGame";
import { useStreamerProfile } from "./useStreamerProfile";

vi.mock("./useStreamerProfile", () => ({
  useStreamerProfile: vi.fn(() => null),
}));

const SESSION_KEY = "knowthechat-party-session";
const player = (id: string, name: string) => ({
  id,
  name,
  score: 0,
  streak: 0,
  bestStreak: 0,
  answered: false,
  choice: null as string | null,
  roundPoints: 0,
});
const waitingRoom = () => ({
  code: "ABC234",
  channel: "example",
  phase: "waiting",
  hostId: "host",
  you: "host",
  players: [player("host", "Harun"), player("friend", "Friend")],
  roundNumber: 0,
  totalRounds: 10,
  roundSeconds: 20,
  deadline: null as number | null,
  serverNow: Date.now(),
  round: null as object | null,
  expiresAt: Date.now() + 3_600_000,
});
const activeRoom = () => ({
  ...waitingRoom(),
  phase: "round",
  roundNumber: 1,
  deadline: Date.now() + 20_000,
  round: {
    id: "round-1",
    text: "The chat never forgets",
    emotes: [],
    sentAt: 1_700_000_000_000,
    difficulty: "medium",
    choices: ["Alice", "Bob", "Carol"],
    author: undefined as string | undefined,
  },
});

function response(data: unknown, status = 200, retryAfter?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
    },
  });
}

function remember() {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ code: "ABC234", token: "test-token" }),
  );
}

beforeEach(() => {
  vi.mocked(useStreamerProfile).mockReturnValue(null);
  vi.stubGlobal("WebSocket", undefined);
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("private party game", () => {
  it.each([200, 503])(
    "keeps final standings while a slow fresh-chat rematch returns %s",
    async (status) => {
      vi.useFakeTimers();
      remember();
      let room = {
        ...waitingRoom(),
        phase: "finished",
        players: [
          { ...player("host", "Harun"), score: 1_000 },
          { ...player("friend", "Friend"), score: 2_000 },
        ],
      };
      let rematchSignal: AbortSignal | undefined;
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation((input, init) => {
          if (!String(input).endsWith("/rematch"))
            return Promise.resolve(response(room));
          return new Promise<Response>((resolve, reject) => {
            rematchSignal = init?.signal ?? undefined;
            const timer = window.setTimeout(() => {
              if (status === 200) {
                room = waitingRoom();
                resolve(response(room));
              } else {
                resolve(
                  response(
                    {
                      error:
                        "Fresh chat could not be loaded. Please try again.",
                      retryAfter: 15,
                    },
                    status,
                  ),
                );
              }
            }, 95_000);
            rematchSignal?.addEventListener(
              "abort",
              () => {
                window.clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        });
      render(<PartyGame onBack={vi.fn()} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Play a rematch →" }),
        );
      });
      expect(
        screen.getByRole("button", { name: "Fetching fresh chat…" }),
      ).toHaveProperty("disabled", true);
      expect(
        screen.getByText(
          "Finding new clues for the next game. This can take a moment.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole("heading", { name: "Friend knows the chat!" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("region", { name: "Scoreboard" }).textContent,
      ).toContain((2_000).toLocaleString());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(rematchSignal?.aborted).toBe(false);
      expect(
        screen.getByRole("button", { name: "Fetching fresh chat…" }),
      ).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(
        screen.queryByText(
          "Finding new clues for the next game. This can take a moment.",
        ),
      ).toBeNull();
      expect(sessionStorage.getItem(SESSION_KEY)).not.toBeNull();
      if (status === 200) {
        expect(
          screen.getByRole("heading", { name: "Gather your chat detectives." }),
        ).toBeTruthy();
        expect(screen.queryByRole("region", { name: "Scoreboard" })).toBeNull();
      } else {
        expect(screen.getByRole("alert").textContent).toBe(
          "Fresh chat could not be loaded. Please try again.",
        );
        expect(
          screen.getByRole("heading", { name: "Friend knows the chat!" }),
        ).toBeTruthy();
        expect(
          screen.getByRole("region", { name: "Scoreboard" }).textContent,
        ).toContain((2_000).toLocaleString());
        expect(screen.getByText("Try again in 15 seconds.")).toBeTruthy();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        expect(
          screen.getByRole("button", { name: "Play a rematch →" }),
        ).toHaveProperty("disabled", false);
      }
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).endsWith("/rematch"),
        ),
      ).toHaveLength(1);
    },
  );

  it("waits past the archive deadline to receive the server's preparation timeout and retry delay", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          signal = init?.signal ?? undefined;
          const timer = window.setTimeout(() => {
            resolve(
              response(
                {
                  error: "Lobby preparation took too long. Please try again.",
                  retryAfter: 15,
                },
                503,
              ),
            );
          }, 95_000);
          signal?.addEventListener(
            "abort",
            () => {
              window.clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    render(<PartyGame onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "Harun" },
    });
    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "example" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create private lobby →" }),
      );
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(signal?.aborted).toBe(false);
    expect(
      screen.getByRole("button", { name: "Building your lobby…" }),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Lobby preparation took too long. Please try again.",
    );
    expect(screen.getByText("Try again in 15 seconds.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create private lobby →" }),
    ).toHaveProperty("disabled", true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears a denied rematch cooldown after the server accepts another rematch", async () => {
    vi.useFakeTimers();
    remember();
    let room = { ...waitingRoom(), phase: "finished" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/rematch")
          ? response(
              { error: "New games are paused for now.", retryAfter: 86_400 },
              429,
            )
          : response(room),
      );
    render(<PartyGame onBack={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play a rematch →" }));
    });
    expect(
      screen.getByRole("button", { name: "Play a rematch →" }),
    ).toHaveProperty("disabled", true);
    room = waitingRoom();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(
      screen.getByRole("button", { name: "Everyone in? Start the game →" }),
    ).toHaveProperty("disabled", false);
    room = { ...waitingRoom(), phase: "finished" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.queryByText(/Try again in/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Play a rematch →" }),
    ).toHaveProperty("disabled", false);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/rematch"),
      ),
    ).toHaveLength(1);
  });

  it("clears a previous membership's start cooldown when joining another room", async () => {
    vi.useFakeTimers();
    remember();
    let room = waitingRoom();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (String(input) === "/api/rooms/ABC234/start")
          return response(
            { error: "New games are paused for now.", retryAfter: 86_400 },
            429,
          );
        if (String(input).endsWith("/leave")) return response({ ok: true });
        if (String(input).endsWith("/join")) {
          room = { ...waitingRoom(), code: "DEF567" };
          return response({ token: "new-token", room });
        }
        if (String(input) === "/api/rooms/DEF567/start") {
          room = { ...activeRoom(), code: "DEF567" };
        }
        return response(room);
      });
    render(<PartyGame onBack={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Everyone in? Start the game →" }),
      );
    });
    expect(
      screen.getByRole("button", { name: "Everyone in? Start the game →" }),
    ).toHaveProperty("disabled", true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leave lobby" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Join a lobby" }));
    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "Harun" },
    });
    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: "DEF567" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Join the crew →" }));
    });
    expect(screen.queryByText(/Try again in/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Everyone in? Start the game →" }),
    ).toHaveProperty("disabled", false);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Everyone in? Start the game →" }),
      );
    });
    expect(screen.getByRole("region", { name: "Round 1 clue" })).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/rooms/DEF567/start",
      ),
    ).toHaveLength(1);
  });

  it.each([
    [undefined, undefined],
    [0, "0"],
    [-1, "-1"],
    ["60", "tomorrow"],
    [86_401, "86401"],
    [null, "Infinity"],
    [{ seconds: 60 }, "1e2"],
  ])(
    "ignores invalid retry data %j / %j without trapping the host",
    async (retryAfter, header) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
          response(
            { error: "Please try again shortly.", retryAfter },
            429,
            header,
          ),
        );
      render(<PartyGame onBack={vi.fn()} />);
      fireEvent.change(screen.getByLabelText("Your display name"), {
        target: { value: "Harun" },
      });
      fireEvent.change(screen.getByLabelText("Twitch channel"), {
        target: { value: "example" },
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Create private lobby →" }),
        );
      });
      expect(screen.getByRole("alert").textContent).toBe(
        "Please try again shortly.",
      );
      expect(screen.queryByText(/Try again in/)).toBeNull();
      const create = screen.getByRole("button", {
        name: "Create private lobby →",
      });
      expect(create).toHaveProperty("disabled", false);
      await act(async () => {
        fireEvent.click(create);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps final scores and the session after a denied rematch and accepts Retry-After", async () => {
    vi.useFakeTimers();
    remember();
    const room = {
      ...activeRoom(),
      phase: "finished",
      roundNumber: 10,
      players: [
        { ...player("host", "Harun"), score: 1_000 },
        { ...player("friend", "Friend"), score: 2_000 },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/rematch")
          ? response({ error: "New games are paused for now." }, 429, "3661")
          : response(room),
      );
    const { unmount } = render(<PartyGame onBack={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play a rematch →" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "New games are paused for now.",
    );
    expect(screen.getByText("Try again in 1 hour 2 minutes.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Play a rematch →" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Leave lobby" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(
      screen.getByRole("heading", { name: "Friend knows the chat!" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Scoreboard" }).textContent,
    ).toContain((2_000).toLocaleString());
    expect(sessionStorage.getItem(SESSION_KEY)).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/rematch"),
      ),
    ).toHaveLength(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disables a denied start without blocking later live gameplay", async () => {
    vi.useFakeTimers();
    remember();
    let room = waitingRoom();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (String(input).endsWith("/start"))
          return response(
            { error: "New games are paused for now.", retryAfter: 61 },
            429,
          );
        return response(room);
      });
    render(<PartyGame onBack={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Everyone in? Start the game →" }),
      );
    });
    expect(
      screen.getByRole("button", { name: "Everyone in? Start the game →" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Leave lobby" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("region", { name: "Lobby players" })).toBeTruthy();
    expect(screen.getByText("Try again in 2 minutes.")).toBeTruthy();
    room = activeRoom();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.queryByText(/Try again in/)).toBeNull();
    expect(screen.getByRole("button", { name: "Guess Alice" })).toHaveProperty(
      "disabled",
      false,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guess Alice" }));
    });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/start"),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/guess"),
      ),
    ).toHaveLength(1);
  });

  it("allows joining and leaving during a room creation cooldown", async () => {
    vi.useFakeTimers();
    const onBack = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (input === "/api/rooms")
          return response(
            {
              error: "Please wait before creating another lobby.",
              retryAfter: 60,
            },
            429,
          );
        if (String(input).endsWith("/join"))
          return response({
            token: "guest-token",
            room: { ...waitingRoom(), you: "friend" },
          });
        if (String(input).endsWith("/leave")) return response({ ok: true });
        return response({ ...waitingRoom(), you: "friend" });
      });
    render(<PartyGame onBack={onBack} />);
    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "Friend" },
    });
    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "example" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create private lobby →" }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Join a lobby" }));
    expect(screen.queryByText(/Try again in/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: "ABC234" },
    });
    expect(
      screen.getByRole("button", { name: "Join the crew →" }),
    ).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Create a lobby" }));
    expect(
      screen.getByRole("button", { name: "Create private lobby →" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText("Try again in 1 minute.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join a lobby" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Join the crew →" }));
    });
    expect(screen.getByRole("button", { name: "Leave lobby" })).toHaveProperty(
      "disabled",
      false,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leave lobby" }));
    });
    expect(onBack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Create a lobby" }));
    expect(
      screen.getByRole("button", { name: "Create private lobby →" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText("Try again in 1 minute.")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/rooms"),
    ).toHaveLength(1);
  });

  it("keeps rejected room inputs and waits for an explicit retry after capacity frees", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        response(
          {
            error: "All rooms are busy. Please try again shortly.",
            retryAfter: 3,
          },
          503,
        ),
      );
    render(<PartyGame onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "Harun" },
    });
    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "example" },
    });
    fireEvent.change(screen.getByLabelText("Rounds"), {
      target: { value: "5" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create private lobby →" }),
      );
    });
    const create = screen.getByRole("button", {
      name: "Create private lobby →",
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "All rooms are busy. Please try again shortly.",
    );
    expect(screen.getByText("Try again in 3 seconds.")).toBeTruthy();
    expect(create).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Your display name")).toHaveProperty(
      "value",
      "Harun",
    );
    expect(screen.getByLabelText("Twitch channel")).toHaveProperty(
      "value",
      "example",
    );
    expect(screen.getByLabelText("Rounds")).toHaveProperty("value", "5");
    fireEvent.submit(create.closest("form")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("Try again in 1 second.")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(create).toHaveProperty("disabled", false);
    expect(screen.queryByText(/Try again in/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(create);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Try again in 3 seconds.")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe(
      "All rooms are busy. Please try again shortly.",
    );
  });

  it("shows the lobby roster before play and scores only between rounds", async () => {
    vi.useFakeTimers();
    remember();
    let room = waitingRoom();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      response(room),
    );
    render(<PartyGame onBack={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("region", { name: "Lobby players" })).toBeTruthy();

    room = activeRoom();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.queryByRole("region", { name: "Scoreboard" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Lobby players" })).toBeNull();
    expect(screen.queryByText("ABC234")).toBeNull();
    const difficulty = screen.getByText("medium");
    expect(difficulty.classList.contains("difficulty")).toBe(true);
    expect(difficulty.classList.contains("medium")).toBe(true);
    expect(screen.queryByText(/medium clue/i)).toBeNull();

    room = {
      ...room,
      players: [
        { ...player("host", "Harun"), answered: true, choice: "Alice" },
        player("friend", "Friend"),
      ],
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(
      screen.getByText("Locked in: Alice. Waiting for the reveal…"),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Scoreboard" })).toBeNull();

    room = {
      ...room,
      phase: "reveal",
      deadline: null,
      round: { ...activeRoom().round, author: "Alice" },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.getByRole("region", { name: "Scoreboard" })).toBeTruthy();

    room = {
      ...activeRoom(),
      roundNumber: 2,
      round: { ...activeRoom().round, id: "round-2" },
    };
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next round →" }));
    });
    expect(screen.getByRole("region", { name: "Round 2 clue" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Scoreboard" })).toBeNull();
  });

  it("creates a lobby with the selected archive and saves a reconnect token", async () => {
    const room = { ...waitingRoom(), players: [player("host", "Harun")] };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ token: "test-token", room }));
    render(<PartyGame onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "Harun" },
    });
    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "@Example" },
    });
    fireEvent.change(screen.getByLabelText("Archive period"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Rounds"), {
      target: { value: "5" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create private lobby →" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Gather your chat detectives.",
      }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rooms",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Harun",
          channel: "example",
          rangeDays: 30,
          chatterPool: 50,
          roundCount: 5,
          roundSeconds: 20,
        }),
      }),
    );
    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY)!)).toEqual({
      code: "ABC234",
      token: "test-token",
    });
    expect(screen.queryByText("ABC234")).toBeNull();
    expect(screen.getByRole("button", { name: "Show room code" })).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Waiting for a friend…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("rejects a malformed join response without saving a broken session", async () => {
    window.history.replaceState(null, "", "/?room=ABC234");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        token: "test-token",
        room: { ...waitingRoom(), players: null },
      }),
    );
    render(<PartyGame onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "Friend" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join the crew →" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The lobby returned an unexpected response. Please try again.",
    );
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(window.location.search).toBe("?room=ABC234");
    expect(screen.getByLabelText("Room code")).toHaveProperty(
      "value",
      "ABC234",
    );
    expect(
      screen.getByRole("button", { name: "Join the crew →" }),
    ).toBeTruthy();
  });

  it("joins an invite from the URL and waits for the host", async () => {
    window.history.replaceState(null, "", "/?theme=dark&room=abc234#party");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        token: "guest-token",
        room: { ...waitingRoom(), you: "friend" },
      }),
    );
    render(<PartyGame onBack={vi.fn()} />);
    expect((screen.getByLabelText("Room code") as HTMLInputElement).value).toBe(
      "ABC234",
    );
    fireEvent.change(screen.getByLabelText("Your display name"), {
      target: { value: "Friend" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join the crew →" }));
    expect(
      await screen.findByText("You’re in! Waiting for the host to start."),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rooms/ABC234/join",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Friend" }),
      }),
    );
    expect(
      screen.queryByRole("button", { name: /start the game/i }),
    ).toBeNull();
    expect(window.location.search).toBe("?theme=dark");
    expect(window.location.hash).toBe("#party");
    expect(screen.queryByText("ABC234")).toBeNull();
  });

  it("restores the room, starts for the host, and locks guesses after submission", async () => {
    remember();
    let room = waitingRoom();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (String(input).endsWith("/start")) room = activeRoom();
        if (String(input).endsWith("/guess"))
          room = {
            ...room,
            players: [
              { ...player("host", "Harun"), answered: true, choice: "Bob" },
              player("friend", "Friend"),
            ],
          };
        return response(room);
      });
    render(<PartyGame onBack={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Everyone in? Start the game →",
      }),
    );
    expect(await screen.findByText("“The chat never forgets”")).toBeTruthy();
    fireEvent.keyDown(window, { key: "2", repeat: true });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/guess"),
      ),
    ).toHaveLength(0);
    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "1" });
    expect(
      await screen.findByText("Locked in: Bob. Waiting for the reveal…"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Guess Alice" }));
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/guess"),
      ),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rooms/ABC234/guess",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ roundId: "round-1", choice: "Bob" }),
      }),
    );
    expect(screen.queryByText(/The answer was/)).toBeNull();
  });

  it("uses server time for the countdown and refuses guesses after the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    remember();
    const room = {
      ...activeRoom(),
      serverNow: Date.now() + 120_000,
      deadline: Date.now() + 125_000,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        response({ ...room, serverNow: Date.now() + 120_000 }),
      );
    render(<PartyGame onBack={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("timer").getAttribute("aria-label")).toBe(
      "5 seconds remaining",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(screen.getByText("Time’s up! Waiting for the reveal…")).toBeTruthy();
    fireEvent.keyDown(window, { key: "1" });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/guess"),
      ),
    ).toHaveLength(0);
    expect(
      (screen.getByRole("button", { name: "Guess Alice" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("does not overlap polls, pauses hidden tabs, and refreshes when visible", async () => {
    vi.useFakeTimers();
    remember();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    let resolvePoll: ((value: Response) => void) | undefined;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolvePoll = resolve;
          }),
      )
      .mockImplementation(async () => response(waitingRoom()));
    render(<PartyGame onBack={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePoll!(response(waitingRoom()));
    });
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows failed joins and clears expired saved sessions", async () => {
    remember();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ error: "This lobby has expired." }, 410),
    );
    render(<PartyGame onBack={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "This lobby has expired.",
    );
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect((screen.getByLabelText("Room code") as HTMLInputElement).value).toBe(
      "ABC234",
    );
  });

  it("reveals round scores in rank order and supports a host rematch", async () => {
    remember();
    const room = {
      ...activeRoom(),
      phase: "finished",
      roundNumber: 10,
      round: { ...activeRoom().round, author: "Alice" },
      players: [
        {
          ...player("host", "Harun"),
          choice: "Alice",
          score: 2_500,
          roundPoints: 1_000,
          bestStreak: 2,
        },
        {
          ...player("friend", "Friend"),
          choice: "Alice",
          score: 3_000,
          roundPoints: 1_200,
        },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        response(String(input).endsWith("/rematch") ? waitingRoom() : room),
      );
    render(<PartyGame onBack={vi.fn()} />);
    expect(
      await screen.findByRole("heading", { name: "Friend knows the chat!" }),
    ).toBeTruthy();
    const rows = within(
      screen.getByRole("region", { name: "Scoreboard" }),
    ).getAllByRole("listitem");
    expect(rows[0].textContent).toContain("Friend");
    expect(rows[1].textContent).toContain(
      `+${(1_000).toLocaleString()} this round`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play a rematch →" }));
    expect(
      await screen.findByRole("heading", {
        name: "Gather your chat detectives.",
      }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rooms/ABC234/rematch",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("keeps guests connected after results so they can see a rematch", async () => {
    vi.useFakeTimers();
    remember();
    let room = { ...waitingRoom(), phase: "finished", you: "friend" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      response(room),
    );
    render(<PartyGame onBack={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.getByText("Waiting for the host to start a rematch."),
    ).toBeTruthy();
    room = { ...waitingRoom(), you: "friend" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(
      screen.getByText("You’re in! Waiting for the host to start."),
    ).toBeTruthy();
  });

  it("keeps the host session alive while viewing final standings", async () => {
    vi.useFakeTimers();
    remember();
    const room = { ...waitingRoom(), phase: "finished" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => response(room));
    render(<PartyGame onBack={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.getByRole("button", { name: "Play a rematch →" }),
    ).toBeTruthy();
    const initialRequests = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_600);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(initialRequests);
    expect(sessionStorage.getItem(SESSION_KEY)).not.toBeNull();
  });

  it.each([401, 404, 410])(
    "returns to setup when a room action reports an expired session (%s)",
    async (status) => {
      remember();
      const room = { ...waitingRoom(), phase: "finished" };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
        String(input).endsWith("/rematch")
          ? response({ error: "This lobby is no longer available." }, status)
          : response(room),
      );
      render(<PartyGame onBack={vi.fn()} />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Play a rematch →" }),
      );
      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        "This lobby is no longer available.",
      );
      expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
      expect(
        (screen.getByLabelText("Room code") as HTMLInputElement).value,
      ).toBe("ABC234");
      expect(
        screen.getByRole("button", { name: "← Back to solo" }),
      ).toBeTruthy();
    },
  );

  it("keeps a valid player session if host permissions change during an action", async () => {
    remember();
    const room = { ...waitingRoom(), phase: "finished" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/rematch")
        ? response({ error: "Only the host can do that." }, 403)
        : response(room),
    );
    render(<PartyGame onBack={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Play a rematch →" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Only the host can do that.",
    );
    expect(sessionStorage.getItem(SESSION_KEY)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Leave lobby" })).toBeTruthy();
  });

  it("hides the room code until explicitly revealed and can hide it again", async () => {
    remember();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      response(waitingRoom()),
    );
    const { container } = render(<PartyGame onBack={vi.fn()} />);
    const show = await screen.findByRole("button", { name: "Show room code" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(container.innerHTML).not.toContain("ABC234");

    fireEvent.click(show);
    expect(screen.getByText("ABC234")).toBeTruthy();
    const hide = screen.getByRole("button", { name: "Hide room code" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(hide);
    expect(container.innerHTML).not.toContain("ABC234");
    expect(screen.getByText("Room code · hidden")).toBeTruthy();
  });

  it("hides the code again when entering another lobby", async () => {
    remember();
    let room = waitingRoom();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/leave")) return response({ ok: true });
      if (input === "/api/rooms") {
        room = { ...waitingRoom(), code: "DEF567" };
        return response({ token: "new-token", room });
      }
      return response(room);
    });
    const { container } = render(<PartyGame onBack={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Show room code" }),
    );
    expect(screen.getByText("ABC234")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Leave lobby" }));
    fireEvent.change(await screen.findByLabelText("Your display name"), {
      target: { value: "Harun" },
    });
    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "example" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create private lobby →" }),
    );
    expect(
      await screen.findByRole("button", { name: "Show room code" }),
    ).toBeTruthy();
    expect(container.innerHTML).not.toContain("ABC234");
    expect(container.innerHTML).not.toContain("DEF567");
    fireEvent.click(screen.getByRole("button", { name: "Show room code" }));
    expect(screen.getByText("DEF567")).toBeTruthy();
  });

  it.each([
    ["Copy room code", "Room code copied!"],
    ["Copy invite link", "Invite copied!"],
  ])("copies with %s without revealing the code", async (button, status) => {
    remember();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      response(waitingRoom()),
    );
    const { container } = render(<PartyGame onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: button }));
    expect(await screen.findByText(status)).toBeTruthy();
    const expected =
      button === "Copy room code"
        ? "ABC234"
        : new URL("/?room=ABC234", window.location.origin).toString();
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(expected).not.toContain("test-token");
    expect(container.innerHTML).not.toContain("ABC234");
    expect(screen.getByRole("button", { name: "Show room code" })).toBeTruthy();
  });

  it.each(["Copy room code", "Copy invite link"])(
    "keeps the code hidden when %s is denied",
    async (button) => {
      remember();
      const writeText = vi
        .fn()
        .mockRejectedValue(new Error("Clipboard denied"));
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        response(waitingRoom()),
      );
      const { container } = render(<PartyGame onBack={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: button }));
      expect(
        await screen.findByText(
          "Could not copy. Try again, or reveal the room code to copy it manually.",
        ),
      ).toBeTruthy();
      expect(container.innerHTML).not.toContain("ABC234");
      expect(screen.queryByLabelText("Invite link")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Show room code" }),
      ).toBeTruthy();
    },
  );

  it("cleans up the saved session and invite when leaving", async () => {
    remember();
    window.history.replaceState(null, "", "/?room=ABC234");
    const onBack = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      response(String(input).endsWith("/leave") ? { ok: true } : waitingRoom()),
    );
    render(<PartyGame onBack={onBack} />);
    fireEvent.click(await screen.findByRole("button", { name: "Leave lobby" }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("celebrates a server-confirmed streak once, keeps the fire across rounds, and respects effects preferences", async () => {
    vi.useFakeTimers();
    remember();
    const onRoundRevealed = vi.fn();
    let room = {
      ...activeRoom(),
      players: [
        { ...player("host", "Harun"), streak: 4, bestStreak: 4 },
        player("friend", "Friend"),
      ],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      response(room),
    );
    const { container, rerender } = render(
      <PartyGame
        onBack={vi.fn()}
        onRoundRevealed={onRoundRevealed}
        preferences={<span>Shared game preferences</span>}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Shared game preferences")).toBeTruthy();
    expect(container.querySelector(".streak-fire")).toBeNull();
    room = {
      ...room,
      phase: "reveal",
      round: { ...room.round, author: "Alice" },
      players: [
        {
          ...player("host", "Harun"),
          streak: 5,
          bestStreak: 5,
          choice: "Alice",
          roundPoints: 1_200,
          answered: true,
        },
        player("friend", "Friend"),
      ],
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.getByText("You're on fire")).toBeTruthy();
    expect(container.querySelector(".streak-fire")).toBeTruthy();
    expect(onRoundRevealed).toHaveBeenCalledExactlyOnceWith(true, 5);
    rerender(
      <PartyGame
        onBack={vi.fn()}
        effectsEnabled={false}
        onRoundRevealed={onRoundRevealed}
      />,
    );
    expect(container.querySelector(".streak-fire")).toBeNull();
    expect(screen.queryByLabelText(/Current streak/)).toBeNull();
    rerender(
      <PartyGame
        onBack={vi.fn()}
        effectsEnabled
        onRoundRevealed={onRoundRevealed}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_600);
    });
    expect(screen.queryByText("You're on fire")).toBeNull();
    expect(container.querySelector(".streak-fire")).toBeTruthy();
    expect(onRoundRevealed).toHaveBeenCalledTimes(1);
    room = {
      ...activeRoom(),
      roundNumber: 2,
      round: { ...activeRoom().round, id: "round-2" },
      players: [
        { ...player("host", "Harun"), streak: 5, bestStreak: 5 },
        player("friend", "Friend"),
      ],
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(container.querySelector(".streak-fire")).toBeTruthy();
    room = {
      ...room,
      phase: "reveal",
      round: { ...room.round, author: "Alice" },
      players: [
        {
          ...player("host", "Harun"),
          streak: 0,
          bestStreak: 5,
          choice: "Bob",
          answered: true,
        },
        player("friend", "Friend"),
      ],
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(container.querySelector(".streak-fire")).toBeNull();
    expect(onRoundRevealed).toHaveBeenLastCalledWith(false, 0);
    expect(onRoundRevealed).toHaveBeenCalledTimes(2);
  });

  it("restores existing fire without replaying a previously revealed milestone or sound", async () => {
    vi.useFakeTimers();
    remember();
    const onRoundRevealed = vi.fn();
    const room = {
      ...activeRoom(),
      phase: "reveal",
      round: { ...activeRoom().round, author: "Alice" },
      players: [
        {
          ...player("host", "Harun"),
          streak: 10,
          bestStreak: 10,
          choice: "Alice",
          roundPoints: 1_200,
          answered: true,
        },
        player("friend", "Friend"),
      ],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      response(room),
    );
    const { container } = render(
      <PartyGame onBack={vi.fn()} onRoundRevealed={onRoundRevealed} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_500);
    });
    expect(container.querySelector(".streak-fire--inferno")).toBeTruthy();
    expect(screen.queryByText("Unstoppable")).toBeNull();
    expect(onRoundRevealed).not.toHaveBeenCalled();
  });
});
