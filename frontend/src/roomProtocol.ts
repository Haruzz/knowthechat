import { RoomError } from "./roomConnection";

type Emote = { id: string; start: number; end: number; url?: string };

export type Player = {
  id: string;
  name: string;
  score: number;
  streak: number;
  bestStreak: number;
  answered: boolean;
  choice: string | null;
  roundPoints: number;
};

export type PartyRound = {
  id: string;
  text: string;
  emotes: Emote[];
  sentAt: number;
  difficulty: "easy" | "medium" | "hard";
  choices: string[];
  author?: string;
};

export type Room = {
  revision?: number;
  code: string;
  channel: string;
  phase: "waiting" | "round" | "reveal" | "finished";
  hostId: string;
  you: string;
  players: Player[];
  roundNumber: number;
  totalRounds: number;
  roundSeconds: number;
  deadline: number | null;
  serverNow: number;
  round: PartyRound | null;
  expiresAt: number;
};

export type Membership = { token: string; room: Room };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlayer(value: unknown): value is Player {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isNumber(value.score) &&
    isNumber(value.streak) &&
    isNumber(value.bestStreak) &&
    typeof value.answered === "boolean" &&
    (value.choice === null || typeof value.choice === "string") &&
    isNumber(value.roundPoints)
  );
}

function isEmote(value: unknown): value is Emote {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    isNumber(value.start) &&
    isNumber(value.end) &&
    (value.url === undefined || typeof value.url === "string")
  );
}

function isRound(value: unknown): value is PartyRound {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    Array.isArray(value.emotes) &&
    value.emotes.every(isEmote) &&
    isNumber(value.sentAt) &&
    (value.difficulty === "easy" ||
      value.difficulty === "medium" ||
      value.difficulty === "hard") &&
    Array.isArray(value.choices) &&
    value.choices.every((choice: unknown) => typeof choice === "string") &&
    (value.author === undefined || typeof value.author === "string")
  );
}

function isRoom(value: unknown): value is Room {
  return (
    isObject(value) &&
    (value.revision === undefined || isNumber(value.revision)) &&
    typeof value.code === "string" &&
    typeof value.channel === "string" &&
    (value.phase === "waiting" ||
      value.phase === "round" ||
      value.phase === "reveal" ||
      value.phase === "finished") &&
    typeof value.hostId === "string" &&
    typeof value.you === "string" &&
    Array.isArray(value.players) &&
    value.players.every(isPlayer) &&
    isNumber(value.roundNumber) &&
    isNumber(value.totalRounds) &&
    isNumber(value.roundSeconds) &&
    (value.deadline === null || isNumber(value.deadline)) &&
    isNumber(value.serverNow) &&
    (value.round === null || isRound(value.round)) &&
    isNumber(value.expiresAt)
  );
}

function invalidResponse(): never {
  throw new RoomError(
    "The lobby returned an unexpected response. Please try again.",
  );
}

/** Both transports validate the same snapshot before exposing typed room data. */
export function parseRoom(value: unknown): Room {
  if (!isRoom(value)) invalidResponse();
  return value;
}

export function parseMembership(value: unknown): Membership {
  if (!isObject(value) || typeof value.token !== "string" || !value.token)
    invalidResponse();
  return { token: value.token, room: parseRoom(value.room) };
}

export function parseLeave(value: unknown): { ok: true } {
  if (!isObject(value) || value.ok !== true) invalidResponse();
  return { ok: true };
}
