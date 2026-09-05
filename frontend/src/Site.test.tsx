import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import Site, { isPrivacyPath } from "./Site";

const originalPath = window.location.pathname;

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", originalPath);
});

describe("site routing", () => {
  it.each(["/audio-credits", "/audio-credits/"])(
    "provides public applause attribution at %s",
    (path) => {
      window.history.replaceState({}, "", path);
      render(<Site />);
      expect(
        screen.getByRole("heading", { name: "Audio credits", level: 1 }),
      ).toBeTruthy();
      expect(screen.getByText("Blender Foundation")).toBeTruthy();
      expect(screen.getByText(/edited by LeeZH/)).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "Applause" }).getAttribute("href"),
      ).toBe("https://opengameart.org/content/applause");
      expect(
        screen
          .getByRole("link", { name: /Creative Commons Attribution/ })
          .getAttribute("href"),
      ).toBe("https://creativecommons.org/licenses/by/3.0/");
      expect(
        screen.getByText(/converted the complete applause recording to MP3/),
      ).toBeTruthy();
      expect(document.title).toBe("Audio credits | Know The Chat");
    },
  );

  it("discloses pseudonymous network rate limits separately from daily admission records", () => {
    window.history.replaceState({}, "", "/privacy");
    render(<Site />);

    expect(
      screen.getByRole("heading", { name: "Multiplayer admission controls" }),
    ).toBeTruthy();
    const network = screen.getByText(/To limit repeated room creation/);
    expect(network.textContent).toContain("SHA-256");
    expect(network.textContent).toContain(
      "pseudonymous identifier, not anonymous data",
    );
    expect(network.textContent).toContain("60-second creation window");
    expect(network.textContent).toContain(
      "does not store the unhashed IP address",
    );
    const admissions = screen.getByText(/Separate admission records contain/);
    expect(admissions.textContent).toContain(
      "reservation identifiers and timestamps",
    );
    expect(admissions.textContent).toContain("including rematches");
    expect(admissions.textContent).toContain("deletion after 24 hours");
    expect(admissions.textContent).toContain(
      "abandoned preparations expire after two minutes",
    );
    expect(admissions.textContent).toContain(
      "retention may outlast application deletion",
    );
  });

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
      screen.getByText(
        /music, music volume, sound-effect and visual-effects preferences/,
      ),
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
    const history = screen.getByText(
      /Rooms also store the original archive settings/,
    );
    expect(history.textContent).toContain(
      "hashes of up to 2,000 recently used quote texts",
    );
    expect(history.textContent).toContain(
      "internal quote history is not sent to players",
    );
    expect(history.textContent).toContain(
      "deleted with the room, within its two-hour lifetime",
    );
    expect(screen.getByText("Effective September 5, 2026")).toBeTruthy();
  });
});
