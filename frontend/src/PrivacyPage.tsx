import { useEffect } from "react";

export default function PrivacyPage() {
  useEffect(() => {
    const previousTitle = document.title;
    const canonical = document.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    const description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    const previousCanonical = canonical?.href;
    const previousDescription = description?.content;

    document.title = "Privacy Policy | Know The Chat";
    canonical?.setAttribute("href", "https://knowthechat.com/privacy");
    description?.setAttribute(
      "content",
      "How Know The Chat processes public chat data, browser storage, operational information, and advertising consent.",
    );

    return () => {
      document.title = previousTitle;
      if (canonical && previousCanonical)
        canonical.setAttribute("href", previousCanonical);
      if (description && previousDescription)
        description.setAttribute("content", previousDescription);
    };
  }, []);

  return (
    <main className="privacy-shell" translate="yes">
      <article className="privacy-policy">
        <header className="privacy-header">
          <a className="privacy-back" href="/">
            ← Back to the game
          </a>
          <p className="eyebrow">KNOW THE CHAT</p>
          <h1>Privacy policy</h1>
          <p className="privacy-updated">Last updated September 3, 2026</p>
          <p className="privacy-intro">
            Know The Chat is an unofficial Twitch chat guessing game operated by
            Harun Bulut. This policy explains what information is processed when
            you use the site and how advertising privacy choices work. It is not
            affiliated with or endorsed by Twitch, Amazon, featured streamers,
            or the archive and emote providers it uses.
          </p>
        </header>

        <section>
          <h2>Information used by the game</h2>
          <p>
            When you start a game, the site processes the Twitch channel name
            you enter and publicly available archived chat messages, usernames,
            badges, timestamps, profile information, and emote metadata. The
            site does not ask for a Twitch login and does not intentionally
            collect private Twitch messages or credentials.
          </p>
        </section>

        <section>
          <h2>Browser storage</h2>
          <p>
            The game stores a per-channel list of previously seen message
            identifiers in your browser&apos;s local storage to reduce repeated
            rounds. You can remove this information using your browser&apos;s
            site data controls. Google&apos;s consent platform may also store
            your privacy choices so it can remember them.
          </p>
        </section>

        <section>
          <h2>Hosting and operational logs</h2>
          <p>
            Cloudflare hosts the site and processes ordinary request data such
            as IP addresses, user agents, timestamps, and requested URLs. The
            application records operational summaries including the requested
            channel, selected time range, result counts, timing, and outcome. It
            does not intentionally log chat message bodies or full archives.
            Cloudflare controls the retention and access settings for production
            platform logs.
          </p>
        </section>

        <section>
          <h2>External data providers</h2>
          <p>
            The application contacts services operated by Twitch, IVR, 7TV,
            BetterTTV, FrankerFaceZ, Zonian, and allowlisted public archive
            providers. These independent services receive ordinary request
            metadata and handle information under their own privacy policies.
          </p>
        </section>

        <section>
          <h2>Advertising, cookies, and consent</h2>
          <p>
            We use Google AdSense to display and measure advertising. Third
            party vendors, including Google, may use cookies, web beacons, IP
            addresses, or similar identifiers to serve and measure ads.
            Google&apos;s use of advertising cookies enables Google and its
            partners to serve ads based on visits to this site or other sites,
            where permitted by your consent choices and applicable law.
          </p>
          <p>
            Visitors in the European Economic Area, the United Kingdom, and
            Switzerland are offered Google&apos;s certified consent message,
            where applicable, with choices to consent, not consent, or manage
            individual options. Google also provides a privacy and cookie
            settings control that lets eligible visitors revisit their choice.
          </p>
          <p>
            Learn more about{" "}
            <a
              href="https://policies.google.com/technologies/partner-sites"
              target="_blank"
              rel="noreferrer"
            >
              how Google uses information from partner sites
            </a>{" "}
            and manage personalized advertising through{" "}
            <a
              href="https://adssettings.google.com/"
              target="_blank"
              rel="noreferrer"
            >
              Google Ads Settings
            </a>
            . The consent message identifies the other advertising vendors that
            may receive information.
          </p>
        </section>

        <section>
          <h2>Retention and your choices</h2>
          <p>
            Browser data remains until you clear it. Operational information and
            information processed by independent providers are retained
            according to their respective settings and policies. You can decline
            or manage advertising consent when the Google message is presented
            and can use browser controls to block or delete cookies and local
            storage.
          </p>
        </section>

        <section>
          <h2>Contact and removal requests</h2>
          <p>
            For a privacy, abuse, or project-controlled content-removal request,
            contact the maintainer through the{" "}
            <a
              href="https://github.com/Haruzz/knowthechat/issues"
              target="_blank"
              rel="noreferrer"
            >
              project issue tracker
            </a>
            . Do not include sensitive or private information in a public issue.
            Requests about information held by an independent archive,
            advertising, or infrastructure provider must also be directed to
            that provider.
          </p>
        </section>

        <footer className="privacy-footer">
          <a href="/">Return to Know The Chat</a>
        </footer>
      </article>
    </main>
  );
}
