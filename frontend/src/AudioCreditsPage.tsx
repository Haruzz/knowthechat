import { useEffect } from "react";

export default function AudioCreditsPage() {
  useEffect(() => {
    const previousTitle = document.title;
    const canonical = document.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    const previousCanonical = canonical?.href;
    document.title = "Audio credits | Know The Chat";
    canonical?.setAttribute("href", "https://knowthechat.com/audio-credits");
    return () => {
      document.title = previousTitle;
      if (canonical && previousCanonical) canonical.href = previousCanonical;
    };
  }, []);

  return (
    <main className="privacy-shell">
      <article className="privacy-policy">
        <header className="privacy-header">
          <a className="privacy-back" href="/">
            ← Know The Chat
          </a>
          <h1>Audio credits</h1>
          <p className="privacy-intro">
            The people behind the music and sounds in Know The Chat.
          </p>
        </header>
        <section>
          <h2>Game-over applause</h2>
          <p>
            <a href="https://opengameart.org/content/applause">Applause</a> by{" "}
            <strong>Blender Foundation</strong>, edited by LeeZH from the{" "}
            <a href="https://opengameart.org/content/endgame">
              Yo Frankie! endgame sound
            </a>
            . Licensed under{" "}
            <a href="https://creativecommons.org/licenses/by/3.0/">
              Creative Commons Attribution 3.0 Unported (CC BY 3.0)
            </a>
            .
          </p>
          <p>
            For this game, we converted the complete applause recording to MP3,
            adjusted its volume, and added gentle opening and closing fades.
          </p>
        </section>
        <section>
          <h2>Lobby and gameplay music</h2>
          <p>
            Music by <a href="https://abstractionmusic.com/">Abstraction</a>{" "}
            (Tallbeard Studios), from the{" "}
            <a href="https://tallbeard.itch.io/music-loop-bundle">
              FREE Music Loop Bundle
            </a>
            , released under{" "}
            <a href="https://creativecommons.org/publicdomain/zero/1.0/">
              CC0 1.0 Universal
            </a>
            .
          </p>
          <p>
            Super Retro Lounge; Three Red Hearts – Penguin Town; Three Red
            Hearts – Sanctuary; Sketchbook 2025-12-11; Sketchbook 2024-10-14.
          </p>
          <p>Complete tracks converted to MP3 with volume adjustments.</p>
        </section>
        <section>
          <h2>Countdown clock</h2>
          <p>
            <a href="https://bigsoundbank.com/clock-s0007.html">
              Clock (sound 0007)
            </a>{" "}
            by Joseph Sardin, published by BigSoundBank / LaSonotheque under
            CC0. The game uses two short excerpts with volume adjustments and
            fades.
          </p>
        </section>
        <footer className="privacy-footer">
          <a href="/">Return to Know The Chat</a>
        </footer>
      </article>
    </main>
  );
}
