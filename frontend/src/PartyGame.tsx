import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from "react";

import StreakEffects from "./StreakEffects";
import GameChannel from "./GameChannel";
import type { MusicScene } from "./music";
import { useCountdownTicks } from "./useCountdownTicks";
import { useStreamerProfile } from "./useStreamerProfile";
import { connectRoom, RoomError } from "./roomConnection";
import {
  parseLeave,
  parseMembership,
  parseRoom,
  type PartyRound,
  type Room,
} from "./roomProtocol";

import "./party.css";

type Session = { code: string; token: string };
type Action = "start" | "guess" | "next" | "rematch" | "leave";
type LimitedAction = "create" | "start" | "rematch";
type Cooldowns = Partial<Record<LimitedAction, number>>;

const SESSION_KEY = "knowthechat-party-session";
const CURRENT_YEAR = new Date().getUTCFullYear();

function inviteCode() {
  return (new URLSearchParams(window.location.search).get("room") ?? "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 6);
}

function savedSession(): Session | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(SESSION_KEY) ?? "null",
    );
    if (
      value &&
      typeof value === "object" &&
      "code" in value &&
      "token" in value &&
      typeof value.code === "string" &&
      /^[A-Z0-9]{6}$/.test(value.code) &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      (!inviteCode() || inviteCode() === value.code)
    )
      return { code: value.code, token: value.token };
  } catch {
    /* Browser storage is optional. */
  }
  return null;
}

function storeSession(session: Session | null) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* Joining still works when browser storage is unavailable. */
  }
}

function limitedAction(action: string): action is LimitedAction {
  return action === "create" || action === "start" || action === "rematch";
}

function retryAfter(response: Response, data: unknown): number | undefined {
  if (response.status !== 429 && response.status !== 503) return;
  const valid = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 86_400;
  if (
    data &&
    typeof data === "object" &&
    "retryAfter" in data &&
    valid(data.retryAfter)
  )
    return Math.ceil(data.retryAfter);
  const header = response.headers.get("Retry-After");
  if (header && /^[1-9]\d{0,5}$/.test(header) && valid(Number(header)))
    return Number(header);
}

function retryDuration(seconds: number): string {
  const unit = (count: number, name: string) =>
    `${count} ${name}${count === 1 ? "" : "s"}`;
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${unit(hours, "hour")}${remainder ? ` ${unit(remainder, "minute")}` : ""}`;
}

async function request<T>(
  path: string,
  controller: AbortController,
  parse: (data: unknown) => T,
  token?: string,
  body?: object,
): Promise<T> {
  const timeout = window.setTimeout(
    () => controller.abort("timeout"),
    path === "/api/rooms" || path.endsWith("/rematch") ? 110_000 : 12_000,
  );
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        data &&
        typeof data === "object" &&
        "error" in data &&
        typeof data.error === "string"
          ? data.error
          : "The lobby could not be reached. Please try again.";
      throw new RoomError(message, response.status, retryAfter(response, data));
    }
    if (!data)
      throw new RoomError(
        "The lobby returned an unexpected response. Please try again.",
      );
    return parse(data);
  } catch (error) {
    if (controller.signal.reason === "timeout")
      throw new RoomError(
        "The lobby took too long to respond. Please try again.",
      );
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function errorMessage(error: unknown) {
  return error instanceof RoomError
    ? error.message
    : "Connection interrupted. Check your connection and try again.";
}

function renderMessage(round: PartyRound) {
  const parts = [];
  let cursor = 0;
  for (const emote of [...round.emotes].sort((a, b) => a.start - b.start)) {
    if (
      emote.start < cursor ||
      emote.end < emote.start ||
      emote.end >= round.text.length
    )
      continue;
    parts.push(round.text.slice(cursor, emote.start));
    const name = round.text.slice(emote.start, emote.end + 1);
    parts.push(
      <img
        key={`${emote.id}-${emote.start}`}
        className="chat-emote"
        alt={name}
        title={name}
        src={
          emote.url ??
          `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emote.id)}/default/dark/3.0`
        }
      />,
    );
    cursor = emote.end + 1;
  }
  parts.push(round.text.slice(cursor));
  return parts;
}

function Scoreboard({ room }: { room: Room }) {
  const revealed = room.phase === "reveal" || room.phase === "finished";
  const players = [...room.players].sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name),
  );
  return (
    <section
      className="party-scoreboard"
      aria-label={room.phase === "waiting" ? "Lobby players" : "Scoreboard"}
    >
      <div className="party-section-heading">
        <h2>{room.phase === "waiting" ? "The crew" : "Leaderboard"}</h2>
        <span>{players.length} / 8 players</span>
      </div>
      <ol className="party-players">
        {players.map((player, index) => (
          <li
            className={player.id === room.you ? "party-you" : ""}
            key={player.id}
          >
            <span className="party-rank" aria-label={`Rank ${index + 1}`}>
              {index + 1}
            </span>
            <span
              className={`party-avatar color-${index % 5}`}
              aria-hidden="true"
            >
              {player.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="party-player-name">
              <strong>
                {player.name}
                {player.id === room.you ? " (you)" : ""}
              </strong>
              <small>
                {player.id === room.hostId ? "Host" : "Player"}
                {room.phase === "round" &&
                  (player.answered ? " · Locked in" : " · Thinking…")}
                {revealed &&
                  (player.choice ? ` · ${player.choice}` : " · No answer")}
              </small>
            </span>
            <span className="party-player-score">
              {room.phase !== "waiting" && (
                <strong>
                  {player.score.toLocaleString()} <span>pts</span>
                </strong>
              )}
              {revealed && (
                <small
                  className={
                    player.roundPoints > 0 ? "party-points-earned" : ""
                  }
                >
                  +{player.roundPoints.toLocaleString()} this round
                </small>
              )}
              {player.streak >= 3 && (
                <small className="party-streak">
                  🔥 {player.streak} in a row
                </small>
              )}
              {room.phase === "waiting" && (
                <small className="party-ready">Ready</small>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function PartyGame({
  onBack,
  effectsEnabled = true,
  preferences,
  onRoundRevealed,
  onInteraction,
  onMusicStateChange,
  onCountdownTick,
}: {
  onBack: () => void;
  effectsEnabled?: boolean;
  preferences?: ReactNode;
  onRoundRevealed?: (correct: boolean, streak: number) => void;
  onInteraction?: () => void;
  onMusicStateChange?: (scene: MusicScene, urgent: boolean) => void;
  onCountdownTick?: (secondsLeft: number) => void;
}) {
  const [session, setSession] = useState<Session | null>(savedSession);
  const [room, setRoom] = useState<Room | null>(null);
  const streamer = useStreamerProfile(room?.channel ?? null);
  const [tab, setTab] = useState<"create" | "join">(() =>
    inviteCode() ? "join" : "create",
  );
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("");
  const [code, setCode] = useState(inviteCode);
  const [lookback, setLookback] = useState(`year:${CURRENT_YEAR}`);
  const [chatterPool, setChatterPool] = useState("50");
  const [roundCount, setRoundCount] = useState("10");
  const [roundSeconds, setRoundSeconds] = useState("20");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [cooldowns, setCooldowns] = useState<Cooldowns>({});
  const [connectionError, setConnectionError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [clockOffset, setClockOffset] = useState(0);
  const [milestone, setMilestone] = useState<number | null>(null);
  const operation = useRef<AbortController | null>(null);
  const actionPending = useRef(false);
  const pendingLeave = useRef(false);
  const backCallback = useRef(onBack);
  const latestRoom = useRef<Room | null>(null);
  const revealCallback = useRef(onRoundRevealed);
  const previousView = useRef<{
    code: string;
    phase: Room["phase"];
    roundId: string | null;
  } | null>(null);
  const phase = room?.phase;
  const me = room?.players.find((player) => player.id === room.you);
  const secondsLeft =
    !room || room.deadline === null
      ? 0
      : Math.max(0, Math.ceil((room.deadline - (now + clockOffset)) / 1_000));
  const musicScene: MusicScene =
    phase === "round"
      ? "gameplay"
      : phase === "reveal" || phase === "finished"
        ? "silent"
        : "lobby";
  const musicUrgent = Boolean(phase === "round" && secondsLeft <= 5);
  useCountdownTicks({
    roundId:
      phase === "round" && room?.round ? `${room.code}:${room.round.id}` : null,
    deadline:
      !room || room.deadline === null ? null : room.deadline - clockOffset,
    enabled: Boolean(
      onCountdownTick &&
      phase === "round" &&
      me &&
      !me.answered &&
      busy !== "guess" &&
      busy !== "leave" &&
      !connectionError,
    ),
    onTick: onCountdownTick ?? (() => {}),
  });
  const isHost = Boolean(room && room.hostId === room.you);
  const retryAction = !room
    ? tab
    : phase === "waiting"
      ? "start"
      : phase === "finished"
        ? "rematch"
        : null;
  const retrySeconds =
    retryAction && limitedAction(retryAction)
      ? Math.max(0, Math.ceil(((cooldowns[retryAction] ?? 0) - now) / 1_000))
      : 0;
  const retryNotice = retrySeconds > 0 && (
    <p className="party-help" role="status">
      Try again in {retryDuration(retrySeconds)}.
    </p>
  );

  const reportActionError = useCallback((problem: unknown, action: string) => {
    setError(errorMessage(problem));
    if (
      limitedAction(action) &&
      problem instanceof RoomError &&
      problem.retryAfter !== undefined
    ) {
      const receivedAt = Date.now();
      const retryUntil = receivedAt + problem.retryAfter * 1_000;
      setNow(receivedAt);
      setCooldowns((current) => ({
        ...current,
        [action]: retryUntil,
      }));
    }
  }, []);

  useEffect(() => {
    if (Object.keys(cooldowns).length === 0) return;
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (Object.values(cooldowns).some((until) => until <= currentTime))
        setCooldowns((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([, until]) => until > currentTime),
          ),
        );
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [cooldowns]);

  useEffect(() => {
    revealCallback.current = onRoundRevealed;
    backCallback.current = onBack;
  }, [onRoundRevealed, onBack]);

  const finishLeave = useCallback(() => {
    if (!pendingLeave.current) return;
    pendingLeave.current = false;
    operation.current?.abort();
    storeSession(null);
    setSession(null);
    setRoom(null);
    latestRoom.current = null;
    previousView.current = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
    backCallback.current();
  }, []);

  const acceptRoom = useCallback((nextRoom: Room) => {
    const latest = latestRoom.current;
    if (
      latest?.code === nextRoom.code &&
      latest.you === nextRoom.you &&
      latest.revision !== undefined &&
      nextRoom.revision !== undefined &&
      nextRoom.revision < latest.revision
    )
      return;
    const membershipChanged =
      latest?.code !== nextRoom.code || latest.you !== nextRoom.you;
    if (
      membershipChanged ||
      (latest?.phase === "finished" && nextRoom.phase === "waiting")
    ) {
      setCooldowns((current) => {
        if (current.start === undefined && current.rematch === undefined)
          return current;
        return current.create === undefined ? {} : { create: current.create };
      });
    }
    if (membershipChanged) {
      setShowCode(false);
      setCopyStatus("");
      const url = new URL(window.location.href);
      if (url.searchParams.has("room")) {
        url.searchParams.delete("room");
        window.history.replaceState(null, "", url);
      }
    }
    latestRoom.current = nextRoom;
    const receivedAt = Date.now();
    const player = nextRoom.players.find(
      (member) => member.id === nextRoom.you,
    );
    const previous = previousView.current;
    const newlyRevealed =
      previous?.code === nextRoom.code &&
      previous.phase === "round" &&
      previous.roundId === nextRoom.round?.id &&
      (nextRoom.phase === "reveal" || nextRoom.phase === "finished");
    previousView.current = {
      code: nextRoom.code,
      phase: nextRoom.phase,
      roundId: nextRoom.round?.id ?? null,
    };
    setRoom(nextRoom);
    setClockOffset(nextRoom.serverNow - receivedAt);
    setNow(receivedAt);
    setConnectionError("");
    if (nextRoom.phase === "waiting" || !player?.streak) setMilestone(null);
    if (newlyRevealed && player) {
      if (player.streak > 0 && player.streak % 5 === 0)
        setMilestone(player.streak);
      revealCallback.current?.(
        player.choice === nextRoom.round?.author,
        player.streak,
      );
    }
  }, []);

  useEffect(() => {
    if (milestone === null) return;
    const timer = window.setTimeout(() => setMilestone(null), 3_500);
    return () => window.clearTimeout(timer);
  }, [milestone]);

  useEffect(
    () => () => {
      operation.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!session) return;
    return connectRoom<Room>({
      code: session.code,
      token: session.token,
      onRoom: acceptRoom,
      parseRoom,
      onProblem: (problem) => {
        if (
          problem instanceof RoomError &&
          [401, 403, 404, 410].includes(problem.status)
        ) {
          if (pendingLeave.current) {
            finishLeave();
            return true;
          }
          operation.current?.abort();
          storeSession(null);
          setSession(null);
          setRoom(null);
          latestRoom.current = null;
          previousView.current = null;
          setCode(session.code);
          setTab("join");
          setError(problem.message);
          return true;
        }
        setConnectionError(
          `${errorMessage(problem)} Reconnecting automatically…`,
        );
        return false;
      },
      fetchRoom: async (controller) => {
        operation.current = controller;
        try {
          return await request(
            `/api/rooms/${session.code}`,
            controller,
            parseRoom,
            session.token,
          );
        } finally {
          if (operation.current === controller) operation.current = null;
        }
      },
      isBusy: () => Boolean(operation.current),
      pollInterval: () =>
        latestRoom.current?.phase === "finished" ? 5_000 : 1_500,
      initialPollDelay: latestRoom.current ? 1_500 : 0,
    });
  }, [session, acceptRoom, finishLeave]);

  useEffect(() => {
    if (phase !== "round") return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    onMusicStateChange?.(musicScene, musicUrgent);
  }, [onMusicStateChange, musicScene, musicUrgent]);

  async function enter(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      actionPending.current ||
      (tab === "create" && (cooldowns.create ?? 0) > Date.now())
    )
      return;
    onInteraction?.();
    actionPending.current = true;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(tab);
    setError("");
    try {
      const archiveYear = lookback.startsWith("year:")
        ? Number(lookback.slice(5))
        : null;
      const joined = await request(
        tab === "create" ? "/api/rooms" : `/api/rooms/${code}/join`,
        controller,
        parseMembership,
        undefined,
        tab === "create"
          ? {
              name: name.trim(),
              channel: channel.trim().toLowerCase().replace(/^@/, ""),
              ...(archiveYear === null
                ? { rangeDays: Number(lookback) }
                : { archiveYear }),
              chatterPool: Number(chatterPool),
              roundCount: Number(roundCount),
              roundSeconds: Number(roundSeconds),
            }
          : { name: name.trim() },
      );
      if (controller.signal.aborted) return;
      const nextSession = { code: joined.room.code, token: joined.token };
      storeSession(nextSession);
      setSession(nextSession);
      latestRoom.current = null;
      previousView.current = null;
      acceptRoom(joined.room);
    } catch (problem) {
      if (!controller.signal.aborted || controller.signal.reason === "timeout")
        reportActionError(problem, tab);
    } finally {
      if (operation.current === controller) operation.current = null;
      actionPending.current = false;
      setBusy("");
    }
  }

  const act = useCallback(
    async (action: Action, choice?: string) => {
      if (
        !session ||
        actionPending.current ||
        (limitedAction(action) && (cooldowns[action] ?? 0) > Date.now())
      )
        return;
      if (
        action === "guess" &&
        (!room?.round ||
          room.phase !== "round" ||
          room.players.find((p) => p.id === room.you)?.answered ||
          Date.now() + clockOffset >= (room.deadline ?? 0))
      )
        return;
      onInteraction?.();
      actionPending.current = true;
      pendingLeave.current = action === "leave";
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      setBusy(action);
      setError("");
      try {
        const result = await request(
          `/api/rooms/${session.code}/${action}`,
          controller,
          (data) => (action === "leave" ? parseLeave(data) : parseRoom(data)),
          session.token,
          action === "guess" ? { roundId: room!.round!.id, choice } : {},
        );
        if (controller.signal.aborted) return;
        if (action === "leave") finishLeave();
        else if ("code" in result) acceptRoom(result);
      } catch (problem) {
        if (
          !controller.signal.aborted ||
          controller.signal.reason === "timeout"
        ) {
          if (
            problem instanceof RoomError &&
            [401, 404, 410].includes(problem.status)
          ) {
            storeSession(null);
            setSession(null);
            setRoom(null);
            setCode(session.code);
            setTab("join");
          }
          reportActionError(problem, action);
        }
      } finally {
        if (operation.current === controller) operation.current = null;
        actionPending.current = false;
        pendingLeave.current = false;
        setBusy("");
      }
    },
    [
      session,
      room,
      clockOffset,
      acceptRoom,
      onInteraction,
      finishLeave,
      cooldowns,
      reportActionError,
    ],
  );

  useEffect(() => {
    if (phase !== "round") return;
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (
        event.repeat ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.closest("input, textarea, select, button, a")))
      )
        return;
      if (["1", "2", "3"].includes(event.key)) {
        const choice = room?.round?.choices[Number(event.key) - 1];
        if (choice) {
          event.preventDefault();
          void act("guess", choice);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, phase, room?.round]);

  const invite = new URL(window.location.href);
  if (room) invite.searchParams.set("room", room.code);
  async function copyInvitation(kind: "code" | "link") {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(
        kind === "code" ? room.code : invite.toString(),
      );
      setCopyStatus(kind === "code" ? "Room code copied!" : "Invite copied!");
    } catch {
      setCopyStatus(
        "Could not copy. Try again, or reveal the room code to copy it manually.",
      );
    }
  }

  if (!room)
    return (
      <main className="simple-shell party-shell" translate="no">
        <section className="simple-card party-setup">
          <button
            type="button"
            className="party-back"
            onClick={() => {
              operation.current?.abort();
              onBack();
            }}
          >
            ← Back to solo
          </button>
          <p className="eyebrow">PRIVATE PARTY · 2–8 PLAYERS</p>
          <h1>
            Same chat.
            <br />
            Friendly rivalry.
          </h1>
          <p className="simple-copy">
            Invite your friends, race the clock, and find out who really knows
            the chat.
          </p>
          {session ? (
            <div className="party-reconnecting" role="status">
              <p>
                Reconnecting to room <strong>{session.code}</strong>…
              </p>
              {connectionError && <p>{connectionError}</p>}
              <button
                className="party-secondary"
                onClick={() => {
                  operation.current?.abort();
                  storeSession(null);
                  setSession(null);
                  setConnectionError("");
                }}
              >
                Return to lobby setup
              </button>
            </div>
          ) : (
            <>
              <div className="party-tabs" aria-label="Choose how to play">
                <button
                  type="button"
                  aria-pressed={tab === "create"}
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setTab("create");
                    setError("");
                  }}
                >
                  Create a lobby
                </button>
                <button
                  type="button"
                  aria-pressed={tab === "join"}
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setTab("join");
                    setError("");
                  }}
                >
                  Join a lobby
                </button>
              </div>
              <form
                className="party-form"
                onSubmit={(event) => void enter(event)}
              >
                <fieldset disabled={Boolean(busy)}>
                  <label htmlFor="party-name">Your display name</label>
                  <input
                    id="party-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="What should we call you?"
                    maxLength={20}
                    minLength={1}
                    required
                    autoComplete="nickname"
                  />
                  {tab === "create" ? (
                    <>
                      <label htmlFor="party-channel">Twitch channel</label>
                      <input
                        id="party-channel"
                        value={channel}
                        onChange={(event) => setChannel(event.target.value)}
                        placeholder="streamer_name"
                        maxLength={25}
                        minLength={3}
                        required
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                      <div className="party-options">
                        <label>
                          Archive period
                          <select
                            value={lookback}
                            onChange={(event) =>
                              setLookback(event.target.value)
                            }
                          >
                            {Array.from(
                              { length: 4 },
                              (_, index) => CURRENT_YEAR - index,
                            ).map((year) => (
                              <option value={`year:${year}`} key={year}>
                                {year}
                              </option>
                            ))}
                            <option value="30">Last 30 days</option>
                            <option value="90">Last 3 months</option>
                          </select>
                        </label>
                        <label>
                          Chatter pool
                          <select
                            value={chatterPool}
                            onChange={(event) =>
                              setChatterPool(event.target.value)
                            }
                          >
                            <option value="25">Core · top 25</option>
                            <option value="50">Balanced · top 50</option>
                            <option value="100">Wide · top 100</option>
                          </select>
                        </label>
                        <label>
                          Rounds
                          <select
                            value={roundCount}
                            onChange={(event) =>
                              setRoundCount(event.target.value)
                            }
                          >
                            <option value="5">5 · quick game</option>
                            <option value="10">10 · classic</option>
                            <option value="20">20 · marathon</option>
                          </select>
                        </label>
                        <label>
                          Time per round
                          <select
                            value={roundSeconds}
                            onChange={(event) =>
                              setRoundSeconds(event.target.value)
                            }
                          >
                            <option value="15">15 seconds</option>
                            <option value="20">20 seconds</option>
                            <option value="30">30 seconds</option>
                          </select>
                        </label>
                      </div>
                    </>
                  ) : (
                    <>
                      <label htmlFor="party-code">Room code</label>
                      <input
                        id="party-code"
                        className="party-code-input"
                        value={code}
                        onChange={(event) =>
                          setCode(
                            event.target.value
                              .replace(/[^a-z0-9]/gi, "")
                              .toUpperCase()
                              .slice(0, 6),
                          )
                        }
                        placeholder="ABC234"
                        minLength={6}
                        maxLength={6}
                        required
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </>
                  )}
                  <button
                    className="launch party-submit"
                    disabled={
                      (tab === "create" && retrySeconds > 0) ||
                      !name.trim() ||
                      (tab === "create"
                        ? channel.trim().length < 3
                        : code.length !== 6)
                    }
                  >
                    {busy
                      ? tab === "create"
                        ? "Building your lobby…"
                        : "Joining…"
                      : tab === "create"
                        ? "Create private lobby →"
                        : "Join the crew →"}
                  </button>
                </fieldset>
              </form>
              {busy === "create" && (
                <p className="party-help" role="status">
                  Finding the best clues in the archive. This can take a moment.
                </p>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="simple-error">
              {error}
            </p>
          )}
          {retryNotice}
          {preferences}
          <p className="party-help">
            1,000 points for a correct answer + up to 500 for speed.
            <br />
            Everyone gets the same clues. Answers stay hidden until the reveal.
          </p>
        </section>
      </main>
    );

  const revealed = phase === "reveal" || phase === "finished";
  const locked = Boolean(
    me?.answered || busy || phase !== "round" || secondsLeft === 0,
  );
  const answeredCount = room.players.filter((player) => player.answered).length;
  const highestScore = Math.max(...room.players.map((player) => player.score));
  const winners = room.players.filter(
    (player) => player.score === highestScore,
  );
  return (
    <main
      className={`game-shell party-game ${effectsEnabled ? "" : "effects-off"}`}
      translate="no"
    >
      <header className="party-header">
        <div className="party-brand-lockup">
          <img
            className="brand-logo mini-logo"
            src="/logo.png"
            alt="Know The Chat"
          />
          <div className="party-room-heading">
            <p className="eyebrow">PRIVATE PARTY</p>
            <strong>Play with friends</strong>
          </div>
        </div>
        <div className="party-header-actions">
          <button
            className="party-secondary"
            disabled={Boolean(busy)}
            onClick={() => void act("leave")}
          >
            {busy === "leave" ? "Leaving…" : "Leave lobby"}
          </button>
          <GameChannel channel={room.channel} streamer={streamer} />
        </div>
      </header>
      <div className="party-content">
        {preferences && <div className="party-preferences">{preferences}</div>}
        {connectionError && (
          <p role="status" className="party-connection">
            {connectionError}
          </p>
        )}
        {error && (
          <p role="alert" className="simple-error">
            {error}
          </p>
        )}
        {retryNotice}
        {phase === "waiting" ? (
          <section className="party-lobby">
            <p className="eyebrow">THE CASE IS READY</p>
            <h1>Gather your chat detectives.</h1>
            <p className="party-description">
              {room.totalRounds} rounds · {room.roundSeconds} seconds per clue ·
              2–8 players
            </p>
            <div className="party-invite">
              <div className="party-code">
                <span>Room code{!showCode && " · hidden"}</span>
                <strong id="party-room-code" aria-hidden={!showCode}>
                  {showCode ? room.code : "••••••"}
                </strong>
                <button
                  className="party-secondary"
                  aria-expanded={showCode}
                  aria-controls="party-room-code"
                  onClick={() => setShowCode((visible) => !visible)}
                >
                  {showCode ? "Hide room code" : "Show room code"}
                </button>
              </div>
              <div className="party-invite-actions">
                <button
                  className="launch"
                  onClick={() => void copyInvitation("code")}
                >
                  Copy room code
                </button>
                <button
                  className="party-secondary"
                  onClick={() => void copyInvitation("link")}
                >
                  Copy invite link
                </button>
              </div>
            </div>
            {copyStatus && (
              <p role="status" className="party-help">
                {copyStatus}
              </p>
            )}
            <Scoreboard room={room} />
            {isHost ? (
              <button
                className="launch party-start"
                disabled={
                  Boolean(busy) || retrySeconds > 0 || room.players.length < 2
                }
                onClick={() => void act("start")}
              >
                {busy === "start"
                  ? "Starting…"
                  : room.players.length < 2
                    ? "Waiting for a friend…"
                    : "Everyone in? Start the game →"}
              </button>
            ) : (
              <p className="party-waiting" role="status">
                You’re in! Waiting for the host to start.
              </p>
            )}
            <p className="party-help">
              Share the invite with friends. Your place is saved in this tab if
              you refresh.
            </p>
          </section>
        ) : (
          <>
            <div className="party-round-status">
              <div>
                <p className="eyebrow">
                  {phase === "finished" ? "CASE CLOSED" : "GUESS TOGETHER"}
                </p>
                <strong>
                  Round {room.roundNumber} <span>/ {room.totalRounds}</span>
                </strong>
              </div>
              {phase === "round" ? (
                <div
                  className={`party-timer ${secondsLeft <= 5 ? "party-timer-urgent" : ""}`}
                >
                  <strong
                    role="timer"
                    aria-label={`${secondsLeft} seconds remaining`}
                  >
                    {secondsLeft}
                    <small>s</small>
                  </strong>
                  <span>
                    {answeredCount} / {room.players.length} locked in
                  </span>
                </div>
              ) : (
                <span className="party-reveal-tag">
                  {phase === "finished"
                    ? "Final standings"
                    : "Answers revealed"}
                </span>
              )}
            </div>
            {phase === "round" && (
              <div className="party-timer-track" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.min(100, (secondsLeft / room.roundSeconds) * 100)}%`,
                  }}
                />
              </div>
            )}
            {phase !== "finished" && (
              <div className="party-streak-effects">
                <StreakEffects
                  streak={me?.streak ?? 0}
                  milestone={milestone}
                  enabled={effectsEnabled}
                />
              </div>
            )}
            {phase === "finished" ? (
              <section className="party-winner">
                <span className="party-trophy" aria-hidden="true">
                  🏆
                </span>
                <h1>
                  {winners.length === 1
                    ? `${winners[0].name} knows the chat!`
                    : "A shared victory!"}
                </h1>
                <p>
                  {winners.length > 1 &&
                    `${winners.map((player) => player.name).join(" & ")} · `}
                  {highestScore.toLocaleString()} points
                </p>
                <p className="party-help">
                  Your best streak: {me?.bestStreak ?? 0} correct in a row
                </p>
              </section>
            ) : (
              room.round && (
                <section
                  className="game-card party-clue"
                  aria-label={`Round ${room.roundNumber} clue`}
                >
                  <p className="message-meta">
                    <time dateTime={new Date(room.round.sentAt).toISOString()}>
                      {new Date(room.round.sentAt).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}
                    </time>
                    <span aria-hidden="true">·</span>
                    <span className={`difficulty ${room.round.difficulty}`}>
                      {room.round.difficulty}
                    </span>
                  </p>
                  <blockquote>“{renderMessage(room.round)}”</blockquote>
                  <div className="answer-area">
                    <p className="prompt">Who said it?</p>
                    <div className="choices">
                      {room.round.choices.map((choice, index) => (
                        <button
                          type="button"
                          key={choice}
                          disabled={locked}
                          className={
                            revealed
                              ? choice === room.round?.author
                                ? "right"
                                : choice === me?.choice
                                  ? "wrong"
                                  : "dim"
                              : choice === me?.choice
                                ? "party-selected"
                                : ""
                          }
                          aria-label={`Guess ${choice}`}
                          aria-pressed={choice === me?.choice}
                          onClick={() => void act("guess", choice)}
                        >
                          <span className="choice-avatar" aria-hidden="true">
                            {choice.slice(0, 2).toUpperCase()}
                          </span>
                          <span className="choice-name">{choice}</span>
                          <span className="choice-key" aria-hidden="true">
                            {index + 1}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p
                      className={`party-answer-status ${revealed || (!me?.answered && secondsLeft > 0 && busy !== "guess") ? "party-sr-only" : ""}`}
                      role="status"
                    >
                      {revealed
                        ? me?.roundPoints
                          ? `You got it! +${me.roundPoints.toLocaleString()} points. ${room.round.author} said it.`
                          : `The answer was ${room.round.author}. ${me?.choice ? "Next clue, fresh start." : "Time ran out."}`
                        : me?.answered
                          ? `Locked in: ${me.choice}. Waiting for the reveal…`
                          : secondsLeft === 0
                            ? "Time’s up! Waiting for the reveal…"
                            : busy === "guess"
                              ? "Locking in your guess…"
                              : "Choose your answer or press 1, 2, or 3."}
                    </p>
                  </div>
                </section>
              )
            )}
            {revealed && <Scoreboard room={room} />}
            {busy === "rematch" && (
              <p className="party-help" role="status">
                Finding new clues for the next game. This can take a moment.
              </p>
            )}
            {revealed && (
              <div className="party-next">
                {isHost ? (
                  <button
                    className="launch"
                    disabled={
                      Boolean(busy) ||
                      (phase === "finished" && retrySeconds > 0)
                    }
                    onClick={() =>
                      void act(phase === "finished" ? "rematch" : "next")
                    }
                  >
                    {busy === "rematch"
                      ? "Fetching fresh chat…"
                      : busy
                        ? "Getting ready…"
                        : phase === "finished"
                          ? "Play a rematch →"
                          : room.roundNumber >= room.totalRounds
                            ? "See final standings →"
                            : "Next round →"}
                  </button>
                ) : (
                  <p className="party-waiting" role="status">
                    {phase === "finished"
                      ? "Waiting for the host to start a rematch."
                      : "Waiting for the host to continue…"}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <footer className="party-footer">
        1,000 for accuracy. Up to 500 for speed. Bragging rights forever.
      </footer>
    </main>
  );
}
