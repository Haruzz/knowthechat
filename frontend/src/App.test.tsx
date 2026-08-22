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
});
