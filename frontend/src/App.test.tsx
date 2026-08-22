import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";

afterEach(() => vi.restoreAllMocks());

describe("Who Said It frontend", () => {
  it("renders the setup surface", () => {
    const currentYear = new Date().getUTCFullYear();
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /how well do you know/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Twitch channel")).toBeTruthy();
    expect(
      (screen.getByLabelText("Archive period") as HTMLSelectElement).value,
    ).toBe(`year:${currentYear}`);
    expect(screen.getByRole("button", { name: /open the case/i })).toBeTruthy();
    const logo = screen.getByRole("img", { name: "Who Said It?" });
    expect(logo.classList.contains("is-loaded")).toBe(false);
    fireEvent.load(logo);
    expect(logo.classList.contains("is-loaded")).toBe(true);
  });

  it("issues the same-origin public archive request", async () => {
    const currentYear = new Date().getUTCFullYear();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (String(input) === "/api/public-archive") {
          return new Response(
            JSON.stringify({
              channel: "example",
              roomId: "99",
              total: 0,
              chatters: [],
              quotes: [],
              range: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "Example" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open the case/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/public-archive",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            channel: "example",
            archiveYear: currentYear,
            chatterPool: 50,
          }),
        }),
      );
    });
  });

  it("shows an unavailable calendar year without starting a game", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/public-archive") {
        return new Response(
          JSON.stringify({ error: "No public archive is available for 2023." }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "Example" },
    });
    fireEvent.change(screen.getByLabelText("Archive period"), {
      target: { value: "year:2023" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open the case/i }));

    expect(
      await screen.findByText("No public archive is available for 2023."),
    ).toBeTruthy();
  });

  it("opens the game without waiting for the optional profile lookup", async () => {
    const chatters = ["Alice", "Bob", "Carol"].map((name, index) => ({
      id: String(index),
      name,
      avatar: name.slice(0, 2),
      messages: 10,
      sub: false,
      vip: false,
      mod: false,
      score: 10,
      activeDays: 3,
      activeMonths: 1,
      avgWords: 5 + index,
    }));
    const quotes = chatters.map((chatter, index) => ({
      id: `quote-${index}`,
      author: chatter.name,
      text: `Distinctive message number ${index}`,
      emotes: [],
      sentAt: 1_700_000_000_000 + index,
      quality: 5,
      difficulty: "medium",
    }));

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("https://api.ivr.fi/"))
        return new Promise<Response>(() => {});
      if (url === "/api/public-archive")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              channel: "example",
              roomId: "",
              total: quotes.length,
              chatters,
              quotes,
              range: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    fireEvent.change(screen.getByLabelText("Twitch channel"), {
      target: { value: "Example" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open the case/i }));

    expect(
      await screen.findByText(/ROUND 1\/3/i, undefined, { timeout: 2_000 }),
    ).toBeTruthy();
  });
});
