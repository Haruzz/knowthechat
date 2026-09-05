import assert from "node:assert/strict";

// Exercise the real Python Worker and SQLite Durable Object, with public archives.
// Intentionally restricted to localhost: this creates disposable rooms.
const origin = new URL(
  process.env.KNOWTHECHAT_BACKEND_ORIGIN ?? "http://127.0.0.1:8787",
);
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname),
  "Use a local Worker.",
);
const channel = process.argv[2] ?? "jaxstyle";
const suffix = Date.now().toString(36);

async function request(
  path,
  { token, body, method = body === undefined ? "GET" : "POST" } = {},
) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function ok(path, options) {
  const { status, payload } = await request(path, options);
  assert.ok(
    status >= 200 && status < 300,
    `${path}: ${status} ${payload.error ?? ""}`,
  );
  return payload;
}

console.log(`Creating local 2-player match from #${channel} public archives…`);
const host = await ok("/api/rooms", {
  body: {
    name: `Host${suffix}`,
    channel,
    rangeDays: 90,
    chatterPool: 50,
    roundCount: 5,
    roundSeconds: 15,
  },
});
const path = `/api/rooms/${host.room.code}`;
const guest = await ok(`${path}/join`, { body: { name: `Guest${suffix}` } });
assert.notEqual(guest.token, host.token);
assert.equal(guest.room.players.length, 2);
assert.equal((await request(path)).status, 401);
assert.ok(
  (await request(`${path}/start`, { token: guest.token, body: {} })).status >=
    400,
);

let room = await ok(`${path}/start`, { token: host.token, body: {} });
assert.equal(room.phase, "round");
const firstRoundId = room.round.id;
for (let number = 1; number <= room.totalRounds; number += 1) {
  assert.equal(room.roundNumber, number);
  assert.equal(
    room.round.author,
    undefined,
    "The answer must stay on the server until reveal.",
  );
  assert.equal(room.round.choices.length, 3);
  assert.ok(room.deadline > room.serverNow);
  const guess = { roundId: room.round.id, choice: room.round.choices[0] };
  const locked = await ok(`${path}/guess`, { token: host.token, body: guess });
  assert.equal(locked.phase, "round");
  const otherView = await ok(path, { token: guest.token });
  const hostView = otherView.players.find(
    (player) => player.id === host.room.you,
  );
  assert.equal(
    hostView.choice,
    null,
    "Other players cannot inspect a locked guess.",
  );
  assert.equal(
    hostView.roundPoints,
    0,
    "Points cannot leak correctness before reveal.",
  );
  assert.equal(otherView.round.author, undefined);
  const duplicate = await request(`${path}/guess`, {
    token: host.token,
    body: guess,
  });
  assert.ok(duplicate.status >= 400 || duplicate.payload.phase === "round");
  room = await ok(`${path}/guess`, { token: guest.token, body: guess });
  assert.ok(["reveal", "finished"].includes(room.phase));
  assert.ok(room.round.choices.includes(room.round.author));
  assert.ok(
    room.players.every(
      (player) => player.roundPoints >= 0 && player.roundPoints <= 1500,
    ),
  );
  room = await ok(`${path}/next`, { token: host.token, body: {} });
}
assert.equal(room.phase, "finished");
console.log(
  "PASS: join, host permissions, five synchronized rounds, hidden answers/guesses, scoring and results.",
);

room = await ok(`${path}/rematch`, { token: host.token, body: {} });
assert.ok(
  room.players.every((player) => player.score === 0 && player.streak === 0),
);
if (room.phase === "waiting")
  room = await ok(`${path}/start`, { token: host.token, body: {} });
assert.notEqual(room.round.id, firstRoundId, "Rematch needs fresh round IDs.");
const stale = await request(`${path}/guess`, {
  token: host.token,
  body: { roundId: firstRoundId, choice: room.round.choices[0] },
});
assert.ok(stale.status >= 400);
await new Promise((resolve) =>
  setTimeout(resolve, Math.max(0, room.deadline - room.serverNow) + 500),
);
room = await ok(path, { token: guest.token });
assert.equal(
  room.phase,
  "reveal",
  "The server must end a round without any guesses.",
);
assert.ok(
  room.players.every((player) => player.score === 0 && player.streak === 0),
);
console.log(
  "PASS: rematch resets scores, rejects stale guesses and expires unanswered rounds.",
);

await ok(`${path}/leave`, { token: host.token, body: {} });
room = await ok(path, { token: guest.token });
assert.equal(room.hostId, guest.room.you);
await ok(`${path}/leave`, { token: guest.token, body: {} });
assert.ok((await request(path, { token: guest.token })).status >= 400);
console.log(
  "PASS: host transfer and empty-room cleanup. Multiplayer smoke check complete.",
);
