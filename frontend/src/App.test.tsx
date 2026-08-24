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
    expect(logo.getAttribute("src")).toBe("/logo.png");
    expect(screen.getByRole("main").getAttribute("translate")).toBe("no");
    expect(
      screen.getByRole("link", { name: "Haruzzz on Twitch" }),
    ).toBeTruthy();
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
              range: {
                oldest: Date.UTC(2026, 0, 25),
                newest: Date.UTC(2026, 7, 24),
              },
              source: "recent",
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
      await screen.findByLabelText("Question 1 of 3, score 0 of 0", undefined, {
        timeout: 2_000,
      }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Available chat period: Jan 25 – Aug 24, 2026"),
    ).toBeTruthy();
    expect(screen.getByText("Chats from Jan 25 – Aug 24, 2026")).toBeTruthy();
    expect(screen.getByLabelText("Game progress")).toBeTruthy();
    expect(screen.getByText("Correct")).toBeTruthy();

    const firstQuote = screen.getByText(/Distinctive message number/i);
    const firstMessage = firstQuote.textContent;
    fireEvent.click(
      screen.getAllByRole("button", { name: /Alice|Bob|Carol/i })[0],
    );
    expect(screen.queryByText(/That’s right\.|That was /)).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: /next message/i }),
    );

    const nextQuote = screen.getByText(/Distinctive message number/i);
    expect(nextQuote).not.toBe(firstQuote);
    expect(nextQuote.textContent).not.toBe(firstMessage);
    expect(screen.getByRole("main").getAttribute("translate")).toBe("no");
  });
});
