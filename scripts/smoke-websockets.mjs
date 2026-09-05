import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Local only: creates a disposable lobby using real public archives and Python DOs.
const origin = new URL(
  process.env.KNOWTHECHAT_BACKEND_ORIGIN ?? "http://127.0.0.1:8787",
);
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname),
  "Use a local Worker.",
);
const channel = process.argv[2] ?? "jaxstyle";
const suffix = Date.now().toString(36);
const peers = [];
const sessions = [];
let path;

async function request(route, { token, body, headers } = {}) {
  const response = await fetch(new URL(route, origin), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, payload: await response.json() };
}

async function ok(route, options) {
  const response = await request(route, options);
  assert.ok(
    response.status >= 200 && response.status < 300,
    `Local room request failed: ${response.status}`,
  );
  return response.payload;
}

async function crossOriginStatus(token) {
  // fetch deliberately rejects Upgrade headers, so use the native HTTP client
  // for this negative handshake check.
  return new Promise((resolve, reject) => {
    const transport = origin.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(new URL(`${path}/events`, origin), {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Origin: "https://unrelated.example",
        "Sec-WebSocket-Protocol": `knowthechat.v1, session.${token}`,
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Cross-origin upgrade unexpectedly accepted."));
    });
    request.on("error", reject);
    request.setTimeout(15_000, () =>
      request.destroy(new Error("Upgrade check timed out.")),
    );
    request.end();
  });
}

async function connect(token) {
  const url = new URL(`${path}/events`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, ["knowthechat.v1", `session.${token}`]);
  const frames = [];
  const pending = new Set();
  let closed = null;

  function deliver(frame) {
    frames.push(frame);
    for (const waiter of [...pending]) {
      if (waiter.predicate(frame)) {
        clearTimeout(waiter.timer);
        pending.delete(waiter);
        waiter.resolve(frame);
      }
    }
  }

  socket.addEventListener("message", (event) => {
    assert.equal(typeof event.data, "string");
    assert.ok(
      !event.data.includes(token),
      "Session tokens must not be echoed.",
    );
    deliver(event.data === "pong" ? { type: "pong" } : JSON.parse(event.data));
  });
  socket.addEventListener("close", (event) => {
    closed = { type: "closed", code: event.code };
    deliver(closed);
  });

  const peer = {
    socket,
    frames,
    wait(predicate, timeout = 15_000) {
      const existing = frames.findLast(predicate);
      if (existing) return Promise.resolve(existing);
      if (closed) return Promise.reject(new Error("Socket already closed."));
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          pending.delete(waiter);
          reject(new Error("Timed out waiting for a live room update."));
        }, timeout);
        pending.add(waiter);
      });
    },
    room(predicate, timeout) {
      return this.wait(
        (frame) => frame.type === "room" && predicate(frame.room),
        timeout,
      ).then((frame) => frame.room);
    },
  };
  peers.push(peer);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Upgrade timed out.")),
      15_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Local WebSocket upgrade failed."));
      },
      { once: true },
    );
  });
  assert.equal(socket.protocol, "knowthechat.v1");
  await peer.room(() => true);
  return peer;
}

try {
  console.log(
    `Creating local WebSocket match from #${channel} public archives…`,
  );
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
  sessions.push(host.token);
  path = `/api/rooms/${host.room.code}`;
  const hostPeer = await connect(host.token);
  const guest = await ok(`${path}/join`, { body: { name: `Guest${suffix}` } });
  sessions.push(guest.token);
  const joined = await hostPeer.room((room) => room.players.length === 2);
  assert.ok(joined.revision > host.room.revision);
  const guestPeer = await connect(guest.token);
  assert.equal(await crossOriginStatus(host.token), 403);

  const round = await ok(`${path}/start`, { token: host.token, body: {} });
  const guestRound = await guestPeer.room(
    (room) => room.revision >= round.revision,
  );
  assert.equal(guestRound.phase, "round");
  assert.equal(guestRound.round.author, undefined);
  const guess = { roundId: round.round.id, choice: round.round.choices[0] };
  const locked = await ok(`${path}/guess`, { token: host.token, body: guess });
  const own = await hostPeer.room((room) => room.revision >= locked.revision);
  const other = await guestPeer.room(
    (room) => room.revision >= locked.revision,
  );
  assert.equal(
    own.players.find((player) => player.id === own.you).choice,
    guess.choice,
  );
  const hidden = other.players.find((player) => player.id === host.room.you);
  assert.equal(hidden.answered, true);
  assert.equal(hidden.choice, null);
  assert.equal(hidden.roundPoints, 0);
  assert.equal(other.round.author, undefined);
  const reveal = await ok(`${path}/guess`, { token: guest.token, body: guess });
  for (const peer of [hostPeer, guestPeer]) {
    const pushed = await peer.room((room) => room.revision >= reveal.revision);
    assert.equal(pushed.phase, "reveal");
    assert.ok(pushed.round.choices.includes(pushed.round.author));
  }
  console.log(
    "PASS: native upgrades, origin checks, instant joins/guesses/reveals and private answers.",
  );

  const next = await ok(`${path}/next`, { token: host.token, body: {} });
  await guestPeer.room((room) => room.revision >= next.revision);
  const deadline = hostPeer.room(
    (room) => room.phase === "reveal" && room.roundNumber === 2,
    25_000,
  );
  // No state GETs, actions or server timers while the object is idle. The ping
  // is answered by the runtime without waking Python; the alarm ends the round.
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  hostPeer.socket.send("ping");
  await hostPeer.wait((frame) => frame.type === "pong");
  const timedOut = await deadline;
  assert.ok(timedOut.revision > next.revision);
  assert.ok(timedOut.players.every((player) => player.roundPoints === 0));
  await guestPeer.room((room) => room.revision >= timedOut.revision);
  console.log(
    "PASS: runtime auto-pong and idle deadline reveal with no HTTP polling.",
  );

  guestPeer.socket.close(1000, "Testing reconnect");
  await guestPeer.wait((frame) => frame.type === "closed");
  const reconnect = await connect(guest.token);
  const restored = await reconnect.room(() => true);
  assert.equal(restored.you, guest.room.you);
  assert.equal(restored.phase, "reveal");
  assert.ok(restored.revision >= timedOut.revision);
  await ok(`${path}/leave`, { token: guest.token, body: {} });
  assert.equal(
    (await reconnect.wait((frame) => frame.type === "error")).status,
    401,
  );
  assert.equal(
    (await reconnect.wait((frame) => frame.type === "closed")).code,
    4001,
  );
  await hostPeer.room(
    (room) => room.players.length === 1 && room.revision > restored.revision,
  );
  await ok(`${path}/leave`, { token: host.token, body: {} });
  assert.equal(
    (await hostPeer.wait((frame) => frame.type === "closed")).code,
    4004,
  );
  assert.equal((await request(path, { token: host.token })).status, 404);
  console.log(
    "PASS: reconnection restores the match; leave and empty-room cleanup close live sockets.",
  );
} finally {
  for (const peer of peers) peer.socket.close();
  if (path) {
    await Promise.allSettled(
      sessions.map((token) => request(`${path}/leave`, { token, body: {} })),
    );
  }
}
