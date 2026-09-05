import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStreamerProfile } from "./useStreamerProfile";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("party streamer profile", () => {
  it("loads the profile once for a channel across repeated room updates", async () => {
    const fetchProfile = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        {
          displayName: "Example",
          logo: "https://static-cdn.jtvnw.net/avatar.png",
        },
      ]),
    );
    const { result, rerender } = renderHook(useStreamerProfile, {
      initialProps: null as string | null,
    });
    expect(fetchProfile).not.toHaveBeenCalled();
    rerender("example");
    await waitFor(() => expect(result.current?.name).toBe("Example"));
    expect(result.current?.logo).toBe(
      "https://static-cdn.jtvnw.net/avatar.png",
    );
    rerender("example");
    expect(fetchProfile).toHaveBeenCalledOnce();
    expect(fetchProfile.mock.calls[0][0]).toBe(
      "https://api.ivr.fi/v2/twitch/user?login=example",
    );
  });

  it("aborts a previous lookup and ignores its result after switching rooms", async () => {
    let finishOld!: (response: Response) => void;
    const fetchProfile = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json([{ logo: "https://static-cdn.jtvnw.net/new.png" }]),
      );
    const { result, rerender } = renderHook(useStreamerProfile, {
      initialProps: "old" as string | null,
    });
    const oldSignal = fetchProfile.mock.calls[0][1]?.signal;
    rerender("new");
    expect(oldSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current?.name).toBe("new"));
    await act(async () => {
      finishOld(
        Response.json([
          { displayName: "Old", logo: "https://static-cdn.jtvnw.net/old.png" },
        ]),
      );
    });
    expect(result.current?.name).toBe("new");
    rerender(null);
    expect(result.current).toBeNull();
  });

  it.each([
    null,
    [],
    [{ logo: 1 }],
    [{ logo: "javascript:alert(1)" }],
    [{ logo: "not-a-url" }],
  ])("ignores an unavailable or invalid profile: %j", async (data) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(data));
    const { result } = renderHook(() => useStreamerProfile("example"));
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it("bounds a stalled profile request and aborts it when leaving", async () => {
    vi.useFakeTimers();
    const fetchProfile = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>(() => {}));
    const { result, unmount } = renderHook(() => useStreamerProfile("example"));
    const signal = fetchProfile.mock.calls[0][1]?.signal;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(signal?.aborted).toBe(true);
    expect(result.current).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
