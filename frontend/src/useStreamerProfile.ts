import { useEffect, useState } from "react";
import type { StreamerProfile } from "./GameChannel";

function parseProfile(data: unknown, channel: string): StreamerProfile | null {
  const user: unknown = Array.isArray(data) ? data[0] : null;
  if (
    !user ||
    typeof user !== "object" ||
    !("logo" in user) ||
    typeof user.logo !== "string"
  )
    return null;
  try {
    if (new URL(user.logo).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    name:
      "displayName" in user &&
      typeof user.displayName === "string" &&
      user.displayName
        ? user.displayName
        : channel,
    logo: user.logo,
  };
}

/** Optional profile lookup, once per channel rather than per room snapshot. */
export function useStreamerProfile(
  channel: string | null,
): StreamerProfile | null {
  const [result, setResult] = useState<{
    channel: string;
    profile: StreamerProfile;
  } | null>(null);
  useEffect(() => {
    if (!channel) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    void fetch(
      `https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(channel)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) return;
        const data: unknown = await response.json();
        const profile = parseProfile(data, channel);
        if (profile && !controller.signal.aborted)
          setResult({ channel, profile });
      })
      .catch(() => {
        // A missing streamer image must not interrupt joining or playing.
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [channel]);
  return result?.channel === channel ? result.profile : null;
}
