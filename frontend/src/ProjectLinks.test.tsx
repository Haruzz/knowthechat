import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import ProjectLinks from "./ProjectLinks";

afterEach(cleanup);

describe("project links", () => {
  it("keeps creator credit and supporting pages accessible without leaving the game", () => {
    render(<ProjectLinks />);

    const links = within(
      screen.getByRole("navigation", { name: "Project links" }),
    );
    expect(
      links.getByRole("link", { name: "Haruzzz on Twitch" }).textContent,
    ).toContain("Made by Haruzzz");
    const destinations = [
      ["Haruzzz on Twitch", "https://www.twitch.tv/haruzzz"],
      [
        "Know The Chat source code on GitHub",
        "https://github.com/Haruzz/knowthechat",
      ],
      ["Privacy", "/privacy"],
      ["Audio credits", "/audio-credits"],
    ];

    expect(links.getAllByRole("link")).toHaveLength(destinations.length);
    for (const [name, href] of destinations) {
      const link = links.getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
    }
  });
});
