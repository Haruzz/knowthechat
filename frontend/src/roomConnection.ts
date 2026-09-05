export class RoomError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

type Options<T extends { code: string }> = {
  code: string;
  token: string;
  onRoom: (room: T) => void;
  parseRoom: (data: unknown) => T;
  onProblem: (problem: unknown) => boolean;
  fetchRoom: (controller: AbortController) => Promise<T>;
  isBusy: () => boolean;
  pollInterval: () => number;
  initialPollDelay: number;
};

/** A visible lobby uses one socket; HTTP snapshots cover blocked connections. */
export function connectRoom<T extends { code: string }>({
  code,
  token,
  onRoom,
  parseRoom,
  onProblem,
  fetchRoom,
  isBusy,
  pollInterval,
  initialPollDelay,
}: Options<T>): () => void {
  let disposed = false;
  let pageHidden = false;
  let socket: WebSocket | null = null;
  let healthy = false;
  let reconnectAttempts = 0;
  let pollFailures = 0;
  let polling = false;
  let pollController: AbortController | null = null;
  let pollTimer: number | undefined;
  let reconnectTimer: number | undefined;
  let handshakeTimer: number | undefined;
  let heartbeatTimer: number | undefined;
  let pongTimer: number | undefined;

  const visible = () =>
    !disposed && !pageHidden && document.visibilityState !== "hidden";

  function stopPolling() {
    polling = false;
    window.clearTimeout(pollTimer);
    pollController?.abort();
  }

  function closeSocket() {
    window.clearTimeout(handshakeTimer);
    window.clearTimeout(heartbeatTimer);
    window.clearTimeout(pongTimer);
    const current = socket;
    socket = null;
    healthy = false;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try {
        current.close(1000, "Lobby connection closed");
      } catch {
        // A browser can reject closing a handshake that already failed.
      }
    }
  }

  function report(problem: unknown) {
    if (onProblem(problem)) {
      dispose();
      return true;
    }
    return false;
  }

  async function poll() {
    if (!visible() || !polling || healthy) return;
    if (pollController || isBusy()) {
      pollTimer = window.setTimeout(() => void poll(), 1_500);
      return;
    }
    const controller = new AbortController();
    pollController = controller;
    try {
      const room = await fetchRoom(controller);
      if (visible() && polling && !controller.signal.aborted && !healthy) {
        onRoom(room);
        pollFailures = 0;
      }
    } catch (problem) {
      if (
        visible() &&
        polling &&
        (!controller.signal.aborted || controller.signal.reason === "timeout")
      ) {
        pollFailures = Math.min(pollFailures + 1, 4);
        report(problem);
      }
    } finally {
      if (pollController === controller) pollController = null;
      if (visible() && polling && !healthy)
        pollTimer = window.setTimeout(
          () => void poll(),
          Math.min(15_000, pollInterval() * 2 ** pollFailures),
        );
    }
  }

  function startPolling(delay = 0) {
    if (polling || !visible()) return;
    polling = true;
    if (delay === 0) void poll();
    else pollTimer = window.setTimeout(() => void poll(), delay);
  }

  function failed() {
    if (!visible()) return;
    closeSocket();
    if (report(new RoomError("Live connection interrupted."))) return;
    startPolling();
    const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempts);
    reconnectAttempts = Math.min(reconnectAttempts + 1, 5);
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, delay);
  }

  function scheduleHeartbeat(current: WebSocket) {
    window.clearTimeout(heartbeatTimer);
    heartbeatTimer = window.setTimeout(() => {
      if (!visible() || socket !== current || !healthy) return;
      try {
        current.send("ping");
        // Cloudflare answers this without waking the hibernating room.
        pongTimer = window.setTimeout(failed, 10_000);
        scheduleHeartbeat(current);
      } catch {
        failed();
      }
    }, 25_000);
  }

  function connect(pollDelay = 0) {
    if (!visible() || socket) return;
    if (typeof window.WebSocket !== "function") {
      startPolling(pollDelay);
      return;
    }
    const url = new URL(`/api/rooms/${code}/events`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try {
      const current = new WebSocket(url, [
        "knowthechat.v1",
        `session.${token}`,
      ]);
      socket = current;
      // Wait for the initial personalized snapshot, not just the handshake.
      handshakeTimer = window.setTimeout(failed, 8_000);
      current.onmessage = (event: MessageEvent<unknown>) => {
        if (!visible() || socket !== current) return;
        if (event.data === "pong") {
          window.clearTimeout(pongTimer);
          return;
        }
        let data: unknown;
        try {
          data = typeof event.data === "string" ? JSON.parse(event.data) : null;
        } catch {
          failed();
          return;
        }
        if (!data || typeof data !== "object" || !("type" in data)) {
          failed();
          return;
        }
        if (
          data.type === "error" &&
          "error" in data &&
          typeof data.error === "string" &&
          "status" in data &&
          typeof data.status === "number"
        ) {
          if (!report(new RoomError(data.error, data.status))) failed();
          return;
        }
        if (data.type !== "room" || !("room" in data)) {
          failed();
          return;
        }
        let room: T;
        try {
          room = parseRoom(data.room);
          if (room.code !== code) {
            failed();
            return;
          }
        } catch {
          failed();
          return;
        }
        const firstSnapshot = !healthy;
        healthy = true;
        reconnectAttempts = 0;
        window.clearTimeout(handshakeTimer);
        window.clearTimeout(pongTimer);
        stopPolling();
        onRoom(room);
        if (firstSnapshot) scheduleHeartbeat(current);
      };
      current.onerror = () => {
        if (socket === current) failed();
      };
      current.onclose = current.onerror;
    } catch {
      failed();
    }
  }

  function suspend() {
    window.clearTimeout(reconnectTimer);
    stopPolling();
    closeSocket();
  }

  function onVisibility() {
    if (visible()) connect();
    else suspend();
  }

  function onPageHide() {
    pageHidden = true;
    suspend();
  }

  function onPageShow() {
    pageHidden = false;
    onVisibility();
  }

  function dispose() {
    disposed = true;
    suspend();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
  }

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  connect(initialPollDelay);
  return dispose;
}
