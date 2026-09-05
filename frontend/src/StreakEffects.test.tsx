import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import StreakEffects from "./StreakEffects";

afterEach(cleanup);

describe("Streak effects", () => {
  it("tracks streaks silently before ignition", () => {
    const { container } = render(
      <StreakEffects streak={3} milestone={null} enabled />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByLabelText(/Current streak/)).toBeNull();
    expect(document.querySelector(".streak-fire")).toBeNull();
  });

  it("celebrates a legendary streak while keeping the decoration hidden from assistive technology", () => {
    render(<StreakEffects streak={15} milestone={15} enabled />);
    expect(screen.getByRole("status").textContent).toBe(
      "Chat legend15 correct in a row",
    );
    expect(
      document
        .querySelector(".streak-fire--legendary")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("retains only the milestone without animated effects", () => {
    render(<StreakEffects streak={5} milestone={5} enabled={false} />);
    expect(screen.queryByLabelText(/Current streak/)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "5 correct in a row",
    );
    expect(document.querySelector(".streak-fire")).toBeNull();
    expect(document.querySelector(".streak-milestone--animated")).toBeNull();
  });
});
