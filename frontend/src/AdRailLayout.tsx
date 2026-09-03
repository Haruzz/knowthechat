import { ReactNode, useEffect, useRef, useState } from "react";

const AD_CLIENT = "ca-pub-2337200194685648";
const WIDE_DESKTOP_QUERY = "(min-width: 1500px)";

const AD_SLOTS = {
  left: "9515984206",
  right: "2532763136",
} as const;

declare global {
  interface Window {
    adsbygoogle?: Record<string, never>[];
  }
}

function useWideDesktop() {
  const [isWideDesktop, setIsWideDesktop] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(WIDE_DESKTOP_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia(WIDE_DESKTOP_QUERY);
    const update = () => setIsWideDesktop(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isWideDesktop;
}

function AdRail({ side }: { side: keyof typeof AD_SLOTS }) {
  const requested = useRef(false);

  useEffect(() => {
    if (!import.meta.env.PROD || requested.current) return;

    requested.current = true;
    try {
      (window.adsbygoogle ??= []).push({});
    } catch (error) {
      console.warn(`Unable to request the ${side} AdSense rail.`, error);
    }
  }, [side]);

  return (
    <div
      className={`ad-rail ad-rail-${side}`}
      role="complementary"
      aria-label={`${side === "left" ? "Left" : "Right"} advertisement`}
    >
      <span className="ad-rail-label">Advertisement</span>
      <ins
        className="adsbygoogle"
        data-ad-client={AD_CLIENT}
        data-ad-slot={AD_SLOTS[side]}
        data-ad-format="vertical"
        data-full-width-responsive="false"
      />
    </div>
  );
}

export default function AdRailLayout({ children }: { children: ReactNode }) {
  const isWideDesktop = useWideDesktop();

  return (
    <div className="site-with-ad-rails">
      {isWideDesktop && <AdRail side="left" />}
      {children}
      {isWideDesktop && <AdRail side="right" />}
    </div>
  );
}
