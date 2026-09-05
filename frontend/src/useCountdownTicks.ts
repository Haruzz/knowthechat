import { useEffect, useRef } from "react";

type CountdownOptions = {
  roundId: string | null;
  /** Deadline adjusted to the local wall clock. */
  deadline: number | null;
  enabled: boolean;
  onTick: (secondsLeft: number) => void;
  /** Only deliberate local previews should sound the initially observed second. */
  playOnStart?: boolean;
};

export function useCountdownTicks({
  roundId,
  deadline,
  enabled,
  onTick,
  playOnStart = false,
}: CountdownOptions): void {
  const callback = useRef(onTick);
  const observed = useRef<{
    roundId: string | null;
    lowest: number;
    enabled: boolean;
  }>({
    roundId: null,
    lowest: Infinity,
    enabled: false,
  });

  useEffect(() => {
    callback.current = onTick;
  }, [onTick]);

  useEffect(() => {
    const isNewRound = observed.current.roundId !== roundId;
    const wasEnabled = observed.current.enabled;
    if (isNewRound) observed.current = { roundId, lowest: Infinity, enabled };
    else observed.current.enabled = enabled;
    if (!roundId || deadline === null || !Number.isFinite(deadline)) return;

    let timer: number | undefined;
    const secondsRemaining = () =>
      Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
    const markCurrent = () => {
      observed.current.lowest = Math.min(
        observed.current.lowest,
        secondsRemaining(),
      );
    };
    const stopTimer = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const tick = () => {
      const seconds = secondsRemaining();
      // The low-water mark also prevents duplicate ticks if a clock correction
      // or a repeated room snapshot moves the visible countdown backwards.
      if (seconds >= observed.current.lowest) return;
      observed.current.lowest = seconds;
      if (seconds === 0) stopTimer();
      if (!document.hidden && seconds >= 1 && seconds <= 5)
        callback.current(seconds);
    };
    const startTimer = () => {
      if (!document.hidden && secondsRemaining() > 0)
        timer = window.setInterval(tick, 200);
    };
    const visibilityChanged = () => {
      stopTimer();
      // Returning to a tab never replays the second elapsed while it was hidden.
      markCurrent();
      startTimer();
    };

    if (
      enabled &&
      !document.hidden &&
      ((isNewRound && playOnStart) || (!isNewRound && wasEnabled))
    )
      tick();
    else markCurrent();
    if (!enabled) return;
    startTimer();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      stopTimer();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [roundId, deadline, enabled, playOnStart]);
}
