import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Site, { isPrivacyPath } from "./Site";

const originalPath = window.location.pathname;

afterEach(() => {
  window.history.replaceState({}, "", originalPath);
  vi.unstubAllGlobals();
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

  it("renders dedicated ad rails on wide desktop screens", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 1500px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    window.history.replaceState({}, "", "/");
    render(<Site />);

    const leftRail = screen.getByRole("complementary", {
      name: "Left advertisement",
    });
    const rightRail = screen.getByRole("complementary", {
      name: "Right advertisement",
    });

    expect(leftRail.querySelector("ins")?.dataset.adSlot).toBe("9515984206");
    expect(rightRail.querySelector("ins")?.dataset.adSlot).toBe("2532763136");
    expect(leftRail.querySelector("ins")?.dataset.adFormat).toBe("vertical");
    expect(rightRail.querySelector("ins")?.dataset.adFormat).toBe("vertical");
  });
});
