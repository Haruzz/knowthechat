import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PartyGame from "./PartyGame";
import { FakeRoomSocket } from "./test/FakeRoomSocket";

const SESSION_KEY = "knowthechat-party-session";
const activeRoom = () => ({
  revision: 2,
  code: "ABC234",
  channel: "example",
  phase: "round",
  hostId: "host",
  you: "host",
  players: [
    {
      id: "host",
      name: "Harun",
      score: 0,
      streak: 4,
      bestStreak: 4,
      answered: false,
      choice: null as string | null,
      roundPoints: 0,
    },
    {
      id: "friend",
      name: "Friend",
      score: 0,
      streak: 0,
      bestStreak: 0,
      answered: false,
      choice: null as string | null,
      roundPoints: 0,
    },
  ],
  roundNumber: 5,
  totalRounds: 10,
  roundSeconds: 20,
  deadline: Date.now() + 20_000,
  serverNow: Date.now(),
  round: {
    id: "round-5",
    text: "The chat never forgets",
    emotes: [],
    sentAt: 1_700_000_000_000,
    difficulty: "medium",
    choices: ["Alice", "Bob", "Carol"],
    author: undefined as string | undefined,
  },
  expiresAt: Date.now() + 3_600_000,
});

function reveal() {
  const room = activeRoom();
  return {
    ...room,
    revision: 4,
    phase: "reveal",
    round: { ...room.round, author: "Alice" },
    players: room.players.map((player) =>
      player.id === "host"
        ? {
            ...player,
            answered: true,
            choice: "Alice",
            streak: 5,
            bestStreak: 5,
            score: 1_200,
            roundPoints: 1_200,
          }
        : player,
    ),
  };
}

function timedOutReveal() {
  const room = reveal();
  return {
    ...room,
    deadline: null,
    players: room.players.map((player) =>
      player.id === room.you
        ? {
            ...player,
            choice: null,
            answered: false,
            streak: 0,
            score: 0,
            roundPoints: 0,
          }
        : player,
    ),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRoomSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeRoomSocket);
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ code: "ABC234", token: "test-token" }),
  );
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live party snapshots", () => {
  it("signals an unanswered timeout once when its leaderboard arrives", async () => {
    const onRoundRevealed = vi.fn();
    render(<PartyGame onBack={vi.fn()} onRoundRevealed={onRoundRevealed} />);
    const socket = FakeRoomSocket.instances[0];
    act(() => socket.message({ type: "room", room: activeRoom() }));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(onRoundRevealed).not.toHaveBeenCalled();
    act(() => socket.message({ type: "room", room: timedOutReveal() }));
    expect(onRoundRevealed).toHaveBeenCalledExactlyOnceWith(false, 0, true);
    expect(screen.getByRole("region", { name: "Scoreboard" })).toBeTruthy();
    act(() => socket.message({ type: "room", room: timedOutReveal() }));
    act(() =>
      socket.message({
        type: "room",
        room: { ...timedOutReveal(), phase: "finished", revision: 5 },
      }),
    );
    expect(onRoundRevealed).toHaveBeenCalledOnce();
  });

  it("does not replay an already completed timeout when restoring a player session", () => {
    const onRoundRevealed = vi.fn();
    render(<PartyGame onBack={vi.fn()} onRoundRevealed={onRoundRevealed} />);
    act(() =>
      FakeRoomSocket.instances[0].message({
        type: "room",
        room: timedOutReveal(),
      }),
    );
    expect(onRoundRevealed).not.toHaveBeenCalled();
  });

  it("keeps a hidden-tab interruption when an in-flight next-round response arrives", async () => {
    const onRoundRevealed = vi.fn();
    let respond!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    render(<PartyGame onBack={vi.fn()} onRoundRevealed={onRoundRevealed} />);
    act(() =>
      FakeRoomSocket.instances[0].message({ type: "room", room: reveal() }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next round →" }));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    const nextRound = activeRoom();
    nextRound.round.id = "round-6";
    await act(async () => {
      respond(new Response(JSON.stringify({ ...nextRound, revision: 5 })));
    });
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    const timeout = timedOutReveal();
    timeout.round.id = "round-6";
    act(() =>
      FakeRoomSocket.instances
        .at(-1)!
        .message({ type: "room", room: { ...timeout, revision: 6 } }),
    );
    expect(onRoundRevealed).not.toHaveBeenCalled();
  });

  it.each(["reconnect", "hidden tab"])(
    "skips an old timeout after a %s interruption",
    async (interruption) => {
      const onRoundRevealed = vi.fn();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        () => new Promise<Response>(() => {}),
      );
      render(<PartyGame onBack={vi.fn()} onRoundRevealed={onRoundRevealed} />);
      act(() =>
        FakeRoomSocket.instances[0].message({
          type: "room",
          room: activeRoom(),
        }),
      );
      if (interruption === "reconnect") {
        act(() => FakeRoomSocket.instances[0].disconnect());
        await act(async () => vi.advanceTimersByTimeAsync(1_000));
      } else {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        act(() => document.dispatchEvent(new Event("visibilitychange")));
        vi.spyOn(document, "hidden", "get").mockReturnValue(false);
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        act(() => document.dispatchEvent(new Event("visibilitychange")));
      }
      const socket = FakeRoomSocket.instances.at(-1)!;
      act(() => socket.message({ type: "room", room: timedOutReveal() }));
      expect(onRoundRevealed).not.toHaveBeenCalled();
      const nextRound = activeRoom();
      nextRound.round.id = "round-6";
      act(() =>
        socket.message({ type: "room", room: { ...nextRound, revision: 5 } }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(20_000));
      const timeout = timedOutReveal();
      timeout.round.id = "round-6";
      act(() =>
        socket.message({ type: "room", room: { ...timeout, revision: 6 } }),
      );
      expect(onRoundRevealed).toHaveBeenCalledExactlyOnceWith(false, 0, true);
    },
  );

  it("ticks once per final second and stops immediately while a guess request is pending", async () => {
    const onCountdownTick = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => {}),
    );
    render(<PartyGame onBack={vi.fn()} onCountdownTick={onCountdownTick} />);
    const socket = FakeRoomSocket.instances[0];
    const room = activeRoom();
    act(() => socket.message({ type: "room", room }));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(onCountdownTick.mock.calls).toEqual([[5]]);
    act(() =>
      socket.message({
        type: "room",
        room: { ...room, serverNow: Date.now() },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onCountdownTick.mock.calls).toEqual([[5], [4]]);
    fireEvent.click(screen.getByRole("button", { name: "Guess Alice" }));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(onCountdownTick.mock.calls).toEqual([[5], [4]]);
    expect(FakeRoomSocket.instances).toHaveLength(1);
  });

  it("resumes only future countdown seconds after the room connection returns", async () => {
    const onCountdownTick = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => {}),
    );
    render(<PartyGame onBack={vi.fn()} onCountdownTick={onCountdownTick} />);
    const room = activeRoom();
    act(() => FakeRoomSocket.instances[0].message({ type: "room", room }));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(onCountdownTick.mock.calls).toEqual([[5]]);
    act(() => FakeRoomSocket.instances[0].disconnect());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() =>
      FakeRoomSocket.instances.at(-1)!.message({
        type: "room",
        room: { ...room, serverNow: Date.now() },
      }),
    );
    expect(onCountdownTick.mock.calls).toEqual([[5]]);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onCountdownTick.mock.calls).toEqual([[5], [3]]);
  });

  it.each(["reveal", "finished", "answered", "leave"])(
    "stops countdown cues after %s",
    async (transition) => {
      const onCountdownTick = vi.fn();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        () => new Promise<Response>(() => {}),
      );
      render(<PartyGame onBack={vi.fn()} onCountdownTick={onCountdownTick} />);
      const socket = FakeRoomSocket.instances[0];
      const room = activeRoom();
      act(() => socket.message({ type: "room", room }));
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(onCountdownTick).toHaveBeenCalledExactlyOnceWith(5);
      if (transition === "leave")
        fireEvent.click(screen.getByRole("button", { name: "Leave lobby" }));
      else
        act(() =>
          socket.message({
            type: "room",
            room: {
              ...room,
              revision: 3,
              serverNow: Date.now(),
              phase: transition === "answered" ? "round" : transition,
              round:
                transition === "answered"
                  ? room.round
                  : { ...room.round, author: "Alice" },
              players: room.players.map((player) =>
                player.id === room.you
                  ? { ...player, answered: true, choice: "Alice" }
                  : player,
              ),
            },
          }),
        );
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(onCountdownTick).toHaveBeenCalledOnce();
    },
  );

  it("keeps final seconds muted after answering, silences leaderboards and restores lobby music for a rematch", async () => {
    const onMusicStateChange = vi.fn();
    render(
      <PartyGame onBack={vi.fn()} onMusicStateChange={onMusicStateChange} />,
    );
    expect(onMusicStateChange).toHaveBeenLastCalledWith("lobby", false);
    const socket = FakeRoomSocket.instances[0];
    const room = activeRoom();
    act(() => socket.message({ type: "room", room }));
    expect(onMusicStateChange).toHaveBeenLastCalledWith("gameplay", false);

    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(onMusicStateChange).toHaveBeenLastCalledWith("gameplay", true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() =>
      socket.message({
        type: "room",
        room: {
          ...room,
          revision: 3,
          serverNow: Date.now(),
          players: room.players.map((player) =>
            player.id === "host"
              ? { ...player, answered: true, choice: "Alice" }
              : player,
          ),
        },
      }),
    );
    expect(onMusicStateChange).toHaveBeenLastCalledWith("gameplay", true);

    act(() => socket.message({ type: "room", room: reveal() }));
    expect(onMusicStateChange).toHaveBeenLastCalledWith("silent", false);
    act(() =>
      socket.message({
        type: "room",
        room: { ...reveal(), revision: 5, phase: "finished" },
      }),
    );
    expect(onMusicStateChange).toHaveBeenLastCalledWith("silent", false);
    act(() =>
      socket.message({
        type: "room",
        room: {
          ...room,
          revision: 6,
          phase: "waiting",
          round: null,
          deadline: null,
          roundNumber: 0,
          serverNow: Date.now(),
        },
      }),
    );
    expect(onMusicStateChange).toHaveBeenLastCalledWith("lobby", false);
    expect(FakeRoomSocket.instances).toHaveLength(1);
  });

  it("keeps music muted at zero while waiting for the shared reveal", async () => {
    const onMusicStateChange = vi.fn();
    render(
      <PartyGame onBack={vi.fn()} onMusicStateChange={onMusicStateChange} />,
    );
    const socket = FakeRoomSocket.instances[0];
    act(() => socket.message({ type: "room", room: activeRoom() }));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(onMusicStateChange).toHaveBeenLastCalledWith("gameplay", true);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(onMusicStateChange).toHaveBeenLastCalledWith("gameplay", true);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(onMusicStateChange).toHaveBeenLastCalledWith("gameplay", true);
  });

  it("reveals an alarm-driven round immediately and celebrates once without polling or reconnecting on preference changes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const firstCallback = vi.fn();
    const updatedCallback = vi.fn();
    const { rerender, unmount } = render(
      <PartyGame onBack={vi.fn()} onRoundRevealed={firstCallback} />,
    );
    const socket = FakeRoomSocket.instances[0];
    act(() => socket.message({ type: "room", room: activeRoom() }));
    expect(screen.getByRole("region", { name: "Round 5 clue" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Scoreboard" })).toBeNull();
    rerender(
      <PartyGame
        onBack={vi.fn()}
        effectsEnabled={false}
        onRoundRevealed={updatedCallback}
      />,
    );
    expect(FakeRoomSocket.instances).toHaveLength(1);
    act(() => socket.message({ type: "room", room: reveal() }));
    expect(screen.getByRole("region", { name: "Scoreboard" })).toBeTruthy();
    expect(screen.getByText("You're on fire")).toBeTruthy();
    expect(updatedCallback).toHaveBeenCalledExactlyOnceWith(true, 5);
    expect(firstCallback).not.toHaveBeenCalled();
    act(() => socket.message({ type: "room", room: reveal() }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(updatedCallback).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeRoomSocket.instances).toHaveLength(1);
    unmount();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers through HTTP when a socket sends an incomplete room instead of crashing the game", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(activeRoom()), { status: 200 }),
      );
    render(<PartyGame onBack={vi.fn()} />);
    const socket = FakeRoomSocket.instances[0];
    await act(async () => {
      socket.message({ type: "room", room: { code: "ABC234", revision: 99 } });
    });
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Round 5 clue" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a newer push when a pending guess responds with an older room revision", async () => {
    let resolveGuess: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveGuess = resolve;
        }),
    );
    const onRoundRevealed = vi.fn();
    render(<PartyGame onBack={vi.fn()} onRoundRevealed={onRoundRevealed} />);
    const socket = FakeRoomSocket.instances[0];
    act(() => socket.message({ type: "room", room: activeRoom() }));
    fireEvent.keyDown(window, { key: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => socket.message({ type: "room", room: reveal() }));
    await act(async () => {
      resolveGuess!(
        new Response(JSON.stringify({ ...activeRoom(), revision: 3 }), {
          status: 200,
        }),
      );
    });
    expect(screen.getByRole("region", { name: "Scoreboard" })).toBeTruthy();
    expect(screen.getByText("You're on fire")).toBeTruthy();
    expect(onRoundRevealed).toHaveBeenCalledExactlyOnceWith(true, 5);
    act(() =>
      socket.message({ type: "room", room: { ...activeRoom(), revision: 2 } }),
    );
    act(() => socket.message({ type: "room", room: reveal() }));
    expect(onRoundRevealed).toHaveBeenCalledTimes(1);
  });

  it.each([401, 404])(
    "finishes an intentional exit once when the socket closes before the leave response (%s)",
    async (status) => {
      window.history.replaceState(null, "", "/?room=ABC234");
      let resolveLeave: ((response: Response) => void) | undefined;
      const onBack = vi.fn();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveLeave = resolve;
          }),
      );
      render(<PartyGame onBack={onBack} />);
      const socket = FakeRoomSocket.instances[0];
      act(() => socket.message({ type: "room", room: activeRoom() }));
      fireEvent.click(screen.getByRole("button", { name: "Leave lobby" }));
      act(() =>
        socket.message({
          type: "error",
          error: "You left this lobby.",
          status,
        }),
      );
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(window.location.search).toBe("");
      expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => {
        resolveLeave!(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
      });
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("aborts a pending guess when the live session is revoked", async () => {
    let resolveGuess: ((response: Response) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((resolve) => {
        resolveGuess = resolve;
      });
    });
    render(<PartyGame onBack={vi.fn()} />);
    const socket = FakeRoomSocket.instances[0];
    act(() => socket.message({ type: "room", room: activeRoom() }));
    fireEvent.keyDown(window, { key: "1" });
    act(() =>
      socket.message({ type: "error", error: "Session expired.", status: 401 }),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolveGuess!(new Response(JSON.stringify(reveal()), { status: 200 }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Session expired.");
    expect(screen.queryByRole("region", { name: "Scoreboard" })).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it.each([401, 403, 404, 410])(
    "clears revoked or expired sessions from a pushed error (%s)",
    (status) => {
      render(<PartyGame onBack={vi.fn()} />);
      const socket = FakeRoomSocket.instances[0];
      act(() => socket.message({ type: "room", room: activeRoom() }));
      act(() =>
        socket.message({
          type: "error",
          error: "This lobby is no longer available.",
          status,
        }),
      );
      expect(screen.getByRole("alert").textContent).toBe(
        "This lobby is no longer available.",
      );
      expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
      expect(screen.getByLabelText("Room code")).toHaveProperty(
        "value",
        "ABC234",
      );
      expect(socket.close).toHaveBeenCalledTimes(1);
    },
  );
});
