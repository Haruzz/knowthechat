import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";

afterEach(() => vi.restoreAllMocks());

describe("Who Said It frontend", () => {
  it("renders the setup surface", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /how well do you know/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Twitch channel")).toBeTruthy();
    expect(
      (screen.getByLabelText("Maximum lookback") as HTMLSelectElement).value,
    ).toBe("1095");
    expect(screen.getByRole("button", { name: /open the case/i })).toBeTruthy();
  });

  it("issues the same-origin public archive request", async () => {
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
            rangeDays: "1095",
            chatterPool: 50,
          }),
        }),
      );
    });
  });
});
