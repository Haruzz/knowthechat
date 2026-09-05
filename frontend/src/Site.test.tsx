import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import Site, { isPrivacyPath } from "./Site";

const originalPath = window.location.pathname;

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", originalPath);
});

describe("site routing", () => {
  it("recognizes privacy paths", () => {
    expect(isPrivacyPath("/privacy")).toBe(true);
    expect(isPrivacyPath("/privacy/")).toBe(true);
    expect(isPrivacyPath("/")).toBe(false);
  });

  it("renders the public privacy policy", () => {
    window.history.replaceState({}, "", "/privacy");
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = "https://knowthechat.com/";
    document.head.append(canonical);
    render(<Site />);

    expect(
      screen.getByRole("heading", { name: "Privacy Policy", level: 1 }),
    ).toBeTruthy();
    expect(screen.getByText(/Google AdSense/)).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: "how Google uses information from partner sites",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Return to Know The Chat" }),
    ).toBeTruthy();
    expect(document.title).toBe("Privacy Policy | Know The Chat");
    expect(canonical.href).toBe("https://knowthechat.com/privacy");
    canonical.remove();
  });

  it("discloses multiplayer storage and expiry alongside browser preferences", () => {
    window.history.replaceState({}, "", "/privacy");
    render(<Site />);

    expect(
      screen.getByText(/sound and visual-effects preferences/),
    ).toBeTruthy();
    const session = screen.getByText(
      /A multiplayer room code and session token/,
    );
    expect(session.textContent).toContain("session storage");
    expect(session.textContent).toContain(
      "Leaving clears the saved player session.",
    );
    expect(session.textContent).toContain("without Twitch accounts");
    expect(
      screen.getByRole("heading", { name: "Private multiplayer rooms" }),
    ).toBeTruthy();
    const rooms = screen.getByText(
      /Private multiplayer rooms store chosen display names/,
    );
    expect(rooms.textContent).toContain("player-session token hashes");
    expect(rooms.textContent).toContain("Cloudflare Durable Object storage");
    expect(rooms.textContent).toContain(
      "display names, scores, and revealed guesses",
    );
    expect(rooms.textContent).toContain("Rooms expire after two hours");
    expect(rooms.textContent).toContain("when the last participant leaves");
    expect(rooms.textContent).toContain(
      "retention may outlast application deletion",
    );
    expect(screen.getByText("Effective September 5, 2026")).toBeTruthy();
  });
});
