import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import Site, { isPrivacyPath } from "./Site";

const originalPath = window.location.pathname;

afterEach(() => {
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
});
