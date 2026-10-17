const LIMIT = 500;
const keyFor = (channel: string) =>
  `knowthechat-seen:${channel.trim().toLowerCase().replace(/^@/, "")}`;

function read(channel: string): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(keyFor(channel)) ?? "[]",
    );
    return Array.isArray(value)
      ? value
          .filter(
            (id): id is string => typeof id === "string" && id.length <= 256,
          )
          .slice(-LIMIT)
      : [];
  } catch {
    return [];
  }
}

// Match the server's opaque key; never expose provider IDs in multiplayer.
export async function messageHistoryKey(id: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(id),
  );
  return (
    "h:" +
    Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}

export async function readSeenHistory(channel: string): Promise<string[]> {
  return Promise.all(
    read(channel).map((id) =>
      /^h:[a-f0-9]{24}$/.test(id) ? id : messageHistoryKey(id),
    ),
  );
}

export function rememberMessage(channel: string, key: string): void {
  const seen = read(channel);
  if (seen.includes(key)) return;
  try {
    localStorage.setItem(
      keyFor(channel),
      JSON.stringify([...seen, key].slice(-LIMIT)),
    );
  } catch {
    // History is optional when browser storage is full or disabled.
  }
}
