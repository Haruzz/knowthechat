import assert from "node:assert/strict";

// Run against an isolated local Worker with limits 1 open / 3 preparations /
// 2 matches / 3 creations per minute. Use fresh local persistence for each run.
const origin = new URL(
  process.env.KNOWTHECHAT_BACKEND_ORIGIN ?? "http://127.0.0.1:8788",
);
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname),
  "Admission smoke tests must use a local Worker.",
);
const channel = process.argv[2] ?? "jaxstyle";
const members = [];

async function request(path, body, token) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(110_000),
  });
  const payload = await response.json();
  return { response, payload };
}

async function ok(path, body, token) {
  const { response, payload } = await request(path, body, token);
  assert.ok(response.ok, `HTTP ${response.status}: ${payload.error}`);
  return payload;
}

function denied(result, message) {
  assert.equal(result.response.status, 429);
  assert.match(result.payload.error, message);
  assert.ok(result.payload.retryAfter > 0);
  assert.equal(
    result.response.headers.get("retry-after"),
    String(result.payload.retryAfter),
  );
  assert.equal(result.response.headers.get("cache-control"), "no-store");
}

const settings = {
  channel,
  name: "Admission host",
  rangeDays: 90,
  chatterPool: 50,
  roundCount: 5,
  roundSeconds: 15,
};

async function finishMatch(host, guest) {
  const texts = [];
  const path = `/api/rooms/${host.room.code}`;
  let room = await ok(`${path}/start`, {}, host.token);
  while (room.phase === "round") {
    texts.push(room.round.text);
    const guess = { roundId: room.round.id, choice: room.round.choices[0] };
    await ok(`${path}/guess`, guess, host.token);
    room = await ok(`${path}/guess`, guess, guest.token);
    assert.equal(room.phase, "reveal");
    room = await ok(`${path}/next`, {}, host.token);
  }
  assert.equal(room.phase, "finished");
  return { room, texts };
}

try {
  const host = await ok("/api/rooms", settings);
  const path = `/api/rooms/${host.room.code}`;
  members.push({ path, token: host.token });
  denied(await request("/api/rooms", settings), /All rooms are busy/);
  console.log("PASS: the occupied room slot rejects another preparation.");

  const guest = await ok(`${path}/join`, { name: "Admission guest" });
  members.push({ path, token: guest.token });
  const first = await finishMatch(host, guest);
  await ok(`${path}/rematch`, {}, host.token);
  const second = await finishMatch(host, guest);
  const final = second.room;
  assert.ok(second.texts.every((text) => !first.texts.includes(text)));
  console.log("PASS: the rematch uses fresh quotes in the same lobby.");
  denied(await request(`${path}/rematch`, {}, host.token), /daily match limit/);
  const retained = await ok(path, undefined, host.token);
  assert.equal(retained.phase, "finished");
  assert.deepEqual(retained.players, final.players);
  console.log(
    "PASS: initial match and rematch count once each; a denied rematch preserves results.",
  );

  await ok(`${path}/leave`, {}, guest.token);
  await ok(`${path}/leave`, {}, host.token);
  const replacement = await ok("/api/rooms", settings);
  const replacementPath = `/api/rooms/${replacement.room.code}`;
  members.push({ path: replacementPath, token: replacement.token });
  await ok(`${replacementPath}/leave`, {}, replacement.token);
  denied(await request("/api/rooms", settings), /daily chat preparation limit/);
  console.log(
    "PASS: leaving releases capacity; daily preparation counts survive room deletion.",
  );
} finally {
  await Promise.allSettled(
    members.map(({ path, token }) => request(`${path}/leave`, {}, token)),
  );
}
