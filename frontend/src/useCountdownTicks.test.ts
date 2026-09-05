import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCountdownTicks } from "./useCountdownTicks";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("countdown tick scheduling", () => {
  it("sounds each last second once, tolerates repeated snapshots and resets for a new round", () => {
    const onTick = vi.fn();
    const props = {
      roundId: "one",
      deadline: Date.now() + 6_000,
      enabled: true,
      onTick,
    };
    const { rerender } = renderHook(useCountdownTicks, { initialProps: props });
    act(() => vi.advanceTimersByTime(1_000));
    expect(onTick.mock.calls).toEqual([[5]]);
    rerender({ ...props });
    // A clock-offset correction moves the countdown back to6 then5 again.
    rerender({ ...props, deadline: props.deadline + 1_000 });
    act(() => vi.advanceTimersByTime(1_000));
    expect(onTick.mock.calls).toEqual([[5]]);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onTick.mock.calls).toEqual([[5], [4], [3], [2], [1]]);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onTick).toHaveBeenCalledTimes(5);
    rerender({ ...props, roundId: "two", deadline: Date.now() + 6_000 });
    act(() => vi.advanceTimersByTime(1_000));
    expect(onTick).toHaveBeenLastCalledWith(5);
    expect(onTick).toHaveBeenCalledTimes(6);
  });

  it("skips hidden seconds and the current second when returning to the tab", () => {
    const onTick = vi.fn();
    renderHook(() =>
      useCountdownTicks({
        roundId: "one",
        deadline: Date.now() + 6_000,
        enabled: true,
        onTick,
      }),
    );
    act(() => vi.advanceTimersByTime(1_000));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(2_000));
    expect(onTick.mock.calls).toEqual([[5]]);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(onTick.mock.calls).toEqual([[5]]);
    act(() => vi.advanceTimersByTime(3_000));
    expect(onTick.mock.calls).toEqual([[5], [2], [1]]);
  });

  it("does not replay the current second after reconnect, pending guesses or muting", () => {
    const onTick = vi.fn();
    const props = {
      roundId: "one" as string | null,
      deadline: Date.now() + 5_000,
      enabled: true,
      onTick,
    };
    const { rerender } = renderHook(useCountdownTicks, { initialProps: props });
    expect(onTick).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(onTick.mock.calls).toEqual([[4]]);
    rerender({ ...props, enabled: false });
    act(() => vi.advanceTimersByTime(1_000));
    rerender(props);
    expect(onTick.mock.calls).toEqual([[4]]);
    act(() => vi.advanceTimersByTime(2_000));
    expect(onTick.mock.calls).toEqual([[4], [2], [1]]);
    rerender({ ...props, roundId: null, enabled: false });
    act(() => vi.advanceTimersByTime(1_000));
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it("starts an intentional preview at5 once even with StrictMode effect replay", () => {
    const onTick = vi.fn();
    const deadline = Date.now() + 5_000;
    const { unmount } = renderHook(
      () =>
        useCountdownTicks({
          roundId: "preview",
          deadline,
          enabled: true,
          onTick,
          playOnStart: true,
        }),
      { reactStrictMode: true },
    );
    expect(onTick.mock.calls).toEqual([[5]]);
    act(() => vi.advanceTimersByTime(1_000));
    expect(onTick.mock.calls).toEqual([[5], [4]]);
    unmount();
    act(() => vi.advanceTimersByTime(5_000));
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});
