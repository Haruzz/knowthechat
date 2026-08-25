import { CSSProperties, SubmitEvent, useEffect, useState } from "react";

type Chatter = {
  id: string;
  name: string;
  avatar: string;
  messages: number;
  sub: boolean;
  vip: boolean;
  mod: boolean;
  score: number;
  activeDays: number;
  activeMonths: number;
  avgWords: number;
};
type Quote = {
  id: string;
  author: string;
  text: string;
  emotes: { id: string; start: number; end: number; url?: string }[];
  sentAt: number;
  quality: number;
  difficulty: "easy" | "medium" | "hard";
};
type Round = Quote & { choices: string[] };

const CURRENT_YEAR = new Date().getUTCFullYear();
const PROFILE_REQUEST_TIMEOUT_MS = 3_000;
const ARCHIVE_YEARS = Array.from(
  { length: 4 },
  (_, index) => CURRENT_YEAR - index,
);

function shuffled<T>(items: T[]) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function playAnswerSound(correct: boolean) {
  try {
    const AudioContextClass = window.AudioContext;
    const context = new AudioContextClass();
    const notes = correct ? [523.25, 659.25, 783.99] : [392, 329.63, 261.63];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + index * (correct ? 0.1 : 0.18);
      oscillator.type = correct ? "sine" : "triangle";
      oscillator.frequency.setValueAtTime(frequency, start);
      if (!correct)
        oscillator.frequency.exponentialRampToValueAtTime(
          frequency * 0.82,
          start + 0.26,
        );
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(correct ? 0.11 : 0.075, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        start + (correct ? 0.28 : 0.32),
      );
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + (correct ? 0.3 : 0.34));
    });
    setTimeout(() => void context.close(), 700);
  } catch {
    /* Sound is optional; browsers may deny audio playback. */
  }
}

async function addBrowserSevenTv(quotes: Quote[], roomId: string) {
  if (!/^\d+$/.test(roomId)) return quotes;
  try {
    const response = await fetch(
      `https://api.7tv.app/v3/users/twitch/${roomId}`,
    );
    if (!response.ok) return quotes;
    const payload = await response.json();
    const catalog = new Map<string, string>();
    for (const emote of payload?.emote_set?.emotes ?? []) {
      const host = emote?.data?.host?.url;
      if (typeof emote?.name === "string" && typeof host === "string")
        catalog.set(
          emote.name,
          `${host.startsWith("//") ? "https:" : ""}${host}/4x.webp`,
        );
    }
    return quotes.map((quote) => {
      const emotes = [...(quote.emotes ?? [])];
      for (const match of quote.text.matchAll(/\S+/gu)) {
        const url = catalog.get(match[0]);
        const start = match.index;
        if (
          url &&
          !emotes.some(
            (emote) =>
              start <= emote.end && start + match[0].length - 1 >= emote.start,
          )
        )
          emotes.push({
            id: `7tv:${match[0]}`,
            start,
            end: start + match[0].length - 1,
            url,
          });
      }
      return { ...quote, emotes: emotes.sort((a, b) => a.start - b.start) };
    });
  } catch {
    return quotes;
  }
}

function renderQuote(quote: Quote) {
  if (!quote.emotes?.length) return quote.text;
  const parts = [];
  let cursor = 0;
  for (const emote of quote.emotes) {
    if (emote.start < cursor || emote.end >= quote.text.length) continue;
    if (emote.start > cursor) parts.push(quote.text.slice(cursor, emote.start));
    const name = quote.text.slice(emote.start, emote.end + 1);
    parts.push(
      <span key={`${emote.id}-${emote.start}`} className="emote-with-label">
        <img
          className="chat-emote"
          src={
            emote.url ??
            `https://static-cdn.jtvnw.net/emoticons/v2/${emote.id}/default/dark/3.0`
          }
          alt={name}
        />
        <span role="tooltip">{name}</span>
      </span>,
    );
    cursor = emote.end + 1;
  }
  if (cursor < quote.text.length) parts.push(quote.text.slice(cursor));
  return parts;
}

function formatArchiveRange(range: { oldest: number; newest: number } | null) {
  if (!range) return "Latest available chat";
  const oldest = new Date(range.oldest);
  const newest = new Date(range.newest);
  const shortDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  });
  if (oldest.getFullYear() === newest.getFullYear())
    return `${shortDate.format(oldest)} – ${shortDate.format(newest)}, ${newest.getFullYear()}`;
  const fullDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${fullDate.format(oldest)} – ${fullDate.format(newest)}`;
}

function ProjectLinks() {
  return (
    <nav className="project-links" aria-label="Project links">
      <a
        className="project-link creator-credit"
        href="https://www.twitch.tv/haruzzz"
        target="_blank"
        rel="noreferrer"
        aria-label="Haruzzz on Twitch"
      >
        <span className="project-link-icon twitch-icon" aria-hidden="true">
          T
        </span>
        Made by <strong>Haruzzz</strong>
      </a>
      <a
        className="project-link repo-link"
        href="https://github.com/Haruzz/knowthechat"
        target="_blank"
        rel="noreferrer"
        aria-label="Know The Chat source code on GitHub"
      >
        <svg
          className="project-link-icon github-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M12 .7a11.5 11.5 0 0 0-3.64 22.42c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.57-.3-5.27-1.29-5.27-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.14c.98 0 1.95.13 2.86.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.4-2.71 5.38-5.29 5.67.42.36.79 1.07.79 2.16v3.24c0 .31.2.67.8.56A11.5 11.5 0 0 0 12 .7Z"
          />
        </svg>
        Source
      </a>
    </nav>
  );
}

function makeRounds(quotes: Quote[], chatters: Chatter[]) {
  const scores = new Map(chatters.map((c) => [c.name, c.score]));
  const chatterMap = new Map(chatters.map((c) => [c.name, c]));
  const grouped = new Map<string, Quote[]>();
  for (const quote of shuffled(quotes)) {
    const group = grouped.get(quote.author) ?? [];
    if (group.length < 15) {
      group.push(quote);
      grouped.set(quote.author, group);
    }
  }
  for (const group of grouped.values())
    group.sort((a, b) => b.quality - a.quality);
  const candidates: Quote[] = [];
  let authors = shuffled([...grouped.keys()]);
  while (authors.length) {
    const nextAuthors = shuffled(authors);
    for (const author of nextAuthors) {
      const quote = grouped.get(author)?.shift();
      if (quote) candidates.push(quote);
    }
    authors = authors.filter(
      (author) => (grouped.get(author)?.length ?? 0) > 0,
    );
  }
  const rounds: Round[] = [];
  let previous = "";
  for (const quote of candidates) {
    if (quote.author === previous && grouped.size > 1) continue;
    const target = scores.get(quote.author) ?? 0;
    const authorStyle = chatterMap.get(quote.author)?.avgWords ?? 0;
    const close = chatters
      .filter((c) => c.name !== quote.author)
      .sort((a, b) => Math.abs(a.score - target) - Math.abs(b.score - target))
      .slice(0, 10);
    const decoys = close.sort(
      (a, b) =>
        Math.abs(b.avgWords - authorStyle) - Math.abs(a.avgWords - authorStyle),
    );
    if (decoys.length < 2) continue;
    rounds.push({
      ...quote,
      choices: shuffled([
        quote.author,
        ...shuffled(decoys)
          .slice(0, 2)
          .map((c) => c.name),
      ]),
    });
    previous = quote.author;
  }
  return rounds;
}

export default function WhoSaidIt() {
  const [channel, setChannel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [streamer, setStreamer] = useState<{
    name: string;
    logo: string;
  } | null>(null);
  const [lookback, setLookback] = useState(`year:${CURRENT_YEAR}`);
  const [mode, setMode] = useState<"unlimited" | "10">("unlimited");
  const [chatterPool, setChatterPool] = useState("50");
  const [rounds, setRounds] = useState<Round[]>([]);
  const [range, setRange] = useState<{ oldest: number; newest: number } | null>(
    null,
  );
  const [index, setIndex] = useState(0);
  const [answered, setAnswered] = useState<string | null>(null);
  const [correct, setCorrect] = useState(0);
  const current = rounds[index];

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!current) return;
      if (["1", "2", "3"].includes(event.key) && !answered) {
        const name = current.choices[Number(event.key) - 1];
        if (name) {
          const isCorrect = name === current.author;
          setAnswered(name);
          playAnswerSound(isCorrect);
          if (isCorrect) setCorrect((value) => value + 1);
        }
      }
      if ((event.key === "Enter" || event.key === " ") && answered) {
        setAnswered(null);
        setIndex((value) => value + 1);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [current, answered]);
  useEffect(() => {
    if (!current || !channel) return;
    const key = `knowthechat-seen:${channel}`;
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(key) || "[]");
    } catch {
      /* Ignore malformed browser-local history. */
    }
    if (!seen.includes(current.id)) {
      seen.push(current.id);
      localStorage.setItem(key, JSON.stringify(seen.slice(-500)));
    }
  }, [current, channel]);

  async function load(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setLoadingProgress(4);
    setStreamer(null);
    setError("");
    const requestedChannel = channel.trim().toLowerCase().replace(/^@/, "");
    const timer = window.setInterval(
      () =>
        setLoadingProgress((value) =>
          value < 28
            ? value + 3
            : value < 62
              ? value + 2
              : value < 89
                ? value + 1
                : value,
        ),
      520,
    );
    void fetch(
      `https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(requestedChannel)}`,
      { signal: AbortSignal.timeout(PROFILE_REQUEST_TIMEOUT_MS) },
    )
      .then((response) => (response.ok ? response.json() : []))
      .then((users) => {
        const user = users?.[0];
        if (user?.logo)
          setStreamer({
            name: user.displayName ?? requestedChannel,
            logo: user.logo,
          });
      })
      .catch(() => {});
    try {
      const archiveYear = lookback.startsWith("year:")
        ? Number(lookback.slice(5))
        : null;
      const response = await fetch("/api/public-archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: requestedChannel,
          ...(archiveYear === null
            ? { rangeDays: Number(lookback) }
            : { archiveYear }),
          chatterPool: Number(chatterPool),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not load this archive.");
        return;
      }
      setLoadingProgress(91);
      const enriched = await addBrowserSevenTv(
        data.quotes ?? [],
        data.roomId ?? "",
      );
      setLoadingProgress(97);
      let seen: string[] = [];
      try {
        seen = JSON.parse(
          localStorage.getItem(`knowthechat-seen:${data.channel}`) || "[]",
        );
      } catch {}
      const freshQuotes = enriched.filter(
        (quote: Quote) => !seen.includes(quote.id),
      );
      const freshRounds = makeRounds(freshQuotes, data.chatters ?? []);
      const freshIds = new Set(freshRounds.map((round) => round.id));
      const replayRounds = makeRounds(enriched, data.chatters ?? []).filter(
        (round) => !freshIds.has(round.id),
      );
      const available = [...freshRounds, ...replayRounds];
      const built = mode === "10" ? available.slice(0, 10) : available;
      if (built.length < 3) {
        setError(
          "That archive does not have enough distinct, recognizable messages in the selected period.",
        );
        return;
      }
      setLoadingProgress(100);
      await new Promise((resolve) => setTimeout(resolve, 260));
      setChannel(data.channel);
      setRange(data.range);
      setRounds(built);
      setIndex(0);
      setCorrect(0);
      setAnswered(null);
    } finally {
      window.clearInterval(timer);
      setLoading(false);
    }
  }
  function answer(name: string) {
    if (answered || !name) return;
    const isCorrect = name === current.author;
    setAnswered(name);
    playAnswerSound(isCorrect);
    if (isCorrect) setCorrect((v) => v + 1);
  }
  function next() {
    setAnswered(null);
    setIndex((v) => v + 1);
  }
  function reset() {
    setRounds([]);
    setIndex(0);
    setAnswered(null);
    setCorrect(0);
  }

  const loadingStage =
    loadingProgress < 25
      ? "Opening the public archive"
      : loadingProgress < 55
        ? "Sampling chat across the timeline"
        : loadingProgress < 78
          ? "Ranking recognizable chatters"
          : loadingProgress < 92
            ? "Selecting the strongest clues"
            : loadingProgress < 100
              ? "Loading channel emotes"
              : "Case file ready";
  const lookbackLabel = lookback.startsWith("year:")
    ? lookback.slice(5)
    : (({ "30": "30 days", "90": "3 months" } as Record<string, string>)[
        lookback
      ] ?? "3 months");
  const poolLabel =
    (
      {
        "25": "Core · top 25",
        "50": "Balanced · top 50",
        "100": "Wide · top 100",
      } as Record<string, string>
    )[chatterPool] ?? "Balanced · top 50";
  if (loading)
    return (
      <main className="simple-shell" translate="no">
        <section className="case-builder">
          <div className="case-portrait">
            {streamer ? (
              <img
                src={streamer.logo}
                alt={`${streamer.name} Twitch profile`}
              />
            ) : (
              <span>{channel.slice(0, 2).toUpperCase()}</span>
            )}
            <i
              style={
                { "--progress": `${loadingProgress * 3.6}deg` } as CSSProperties
              }
            />
          </div>
          <p className="eyebrow">BUILDING #{streamer?.name ?? channel}</p>
          <h1>Preparing the case file</h1>
          <div className="case-settings">
            <span>History · {lookbackLabel}</span>
            <span>Chatters · {poolLabel}</span>
            <span>Game · {mode === "10" ? "10 questions" : "Unlimited"}</span>
          </div>
          <p className="case-stage">
            {loadingStage}
            <span className="loading-dots">…</span>
          </p>
          <div
            className="case-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={loadingProgress}
          >
            <span style={{ width: `${loadingProgress}%` }} />
          </div>
          <div className="case-progress-meta">
            <span>{loadingProgress}%</span>
            <span>Messages → chatters → clues → emotes</span>
          </div>
        </section>
        <ProjectLinks />
      </main>
    );

  if (rounds.length > 0 && index >= rounds.length)
    return (
      <main className="simple-shell" translate="no">
        <section className="simple-card end-card">
          <p className="eyebrow">CASE CLOSED</p>
          <h1>
            {correct} / {rounds.length}
          </h1>
          <p>You knew {channel}&apos;s chat.</p>
          <button className="launch" onClick={reset}>
            Try another channel
          </button>
        </section>
        <ProjectLinks />
      </main>
    );

  if (!current)
    return (
      <main className="simple-shell" translate="no">
        <section className="simple-card">
          <div className="brand-lockup logo-only">
            <img className="brand-logo" src="/logo.png" alt="Who Said It?" />
          </div>
          <h1>
            How well do you know
            <br />
            your chat?
          </h1>
          <p className="simple-copy">
            Enter a Twitch channel. We’ll keep only distinctive messages from
            its most recognizable chatters and start the game.
          </p>
          <form className="channel-form" onSubmit={load}>
            <label htmlFor="channel">Twitch channel</label>
            <div>
              <span>#</span>
              <input
                id="channel"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                placeholder="streamer_name"
                autoFocus
              />
              <button disabled={loading || channel.trim().length < 3}>
                {loading ? "Building game…" : "Open the case →"}
              </button>
            </div>
            <section className="game-options">
              <label>
                Archive period
                <select
                  value={lookback}
                  onChange={(e) => setLookback(e.target.value)}
                >
                  <option value="30">Up to 30 days</option>
                  <option value="90">Up to 3 months</option>
                  {ARCHIVE_YEARS.map((year) => (
                    <option key={year} value={`year:${year}`}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Chatter pool
                <select
                  value={chatterPool}
                  onChange={(e) => setChatterPool(e.target.value)}
                >
                  <option value="25">Core · top 25</option>
                  <option value="50">Balanced · top 50</option>
                  <option value="100">Wide · top 100</option>
                </select>
              </label>
              <label>
                Game length
                <select
                  value={mode}
                  onChange={(e) =>
                    setMode(e.target.value as "unlimited" | "10")
                  }
                >
                  <option value="unlimited">Unlimited</option>
                  <option value="10">10 questions</option>
                </select>
              </label>
            </section>
          </form>
          {error && <p className="simple-error">{error}</p>}
          <p className="privacy-note">
            Public archives only · actual coverage depends on the channel
            archive · no Twitch connection
          </p>
        </section>
        <ProjectLinks />
      </main>
    );

  const rangeText = formatArchiveRange(range);
  const completedQuestions = index + (answered ? 1 : 0);
  const roundProgress = ((index + 1) / rounds.length) * 100;
  return (
    <main className="game-shell" translate="no">
      <header className="game-top">
        <button
          className="brand mini"
          onClick={reset}
          aria-label="Back to setup"
        >
          <img
            className="brand-logo mini-logo"
            src="/logo.png"
            alt="Who Said It?"
          />
        </button>
        <div className="game-context">
          <p
            className="game-period"
            aria-label={`Available chat period: ${rangeText}`}
          >
            Chats from {rangeText}
          </p>
          <div
            className="game-stats"
            aria-label={`Question ${index + 1} of ${rounds.length}, score ${correct} of ${completedQuestions}`}
            aria-live="polite"
          >
            <div className="game-stat">
              <span>Question</span>
              <strong>
                {index + 1} <small>/ {rounds.length}</small>
              </strong>
            </div>
            <span className="game-stats-divider" aria-hidden="true" />
            <div className="game-stat">
              <span>Correct</span>
              <strong>
                {correct} <small>/ {completedQuestions}</small>
              </strong>
            </div>
          </div>
          <div
            className="round-progress"
            role="progressbar"
            aria-label="Game progress"
            aria-valuemin={1}
            aria-valuemax={rounds.length}
            aria-valuenow={index + 1}
          >
            <span style={{ width: `${roundProgress}%` }} />
          </div>
        </div>
        <div className="game-channel">
          {streamer && <img src={streamer.logo} alt="" />}
          <div>
            <span>Playing</span>
            <strong>#{streamer?.name ?? channel}</strong>
          </div>
        </div>
      </header>
      <div className="game-stage">
        <section
          key={current.id}
          className={`game-card ${answered ? (answered === current.author ? "answer-correct" : "answer-wrong") : ""}`}
        >
          <p className="message-meta">
            <time dateTime={new Date(current.sentAt).toISOString()}>
              {new Date(current.sentAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </time>
            <span aria-hidden="true">·</span>
            <span className={`difficulty ${current.difficulty}`}>
              {current.difficulty}
            </span>
          </p>
          <blockquote>“{renderQuote(current)}”</blockquote>
          <div className="answer-area">
            <p className="prompt">Who said it?</p>
            <div className="choices">
              {current.choices.map((name, i) => (
                <button
                  key={name}
                  onClick={() => answer(name)}
                  className={
                    answered
                      ? name === current.author
                        ? "right"
                        : name === answered
                          ? "wrong"
                          : "dim"
                      : ""
                  }
                >
                  <span className="choice-avatar" aria-hidden="true">
                    {name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="choice-name">{name}</span>
                  <span className="choice-key" aria-hidden="true">
                    {i + 1}
                  </span>
                </button>
              ))}
            </div>
            {answered && (
              <div className="result result-action">
                <button onClick={next}>
                  {index + 1 === rounds.length
                    ? "See results →"
                    : "Next message →"}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
      <ProjectLinks />
    </main>
  );
}
