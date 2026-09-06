export default function ProjectLinks() {
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
      <a
        className="project-link privacy-link"
        href="/privacy"
        target="_blank"
        rel="noreferrer"
      >
        Privacy
      </a>
      <a
        className="project-link"
        href="/audio-credits"
        target="_blank"
        rel="noreferrer"
      >
        Audio credits
      </a>
    </nav>
  );
}
