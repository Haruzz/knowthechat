# Know The Chat

Know The Chat is a public Twitch chat guessing game. Enter a channel name and
the game builds rounds from publicly available chat archives, prioritizing
recognizable and active chatters while filtering commands, bots, and automated
messages.

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Useful commands:

- `npm run build` creates the production build.
- `npm test` builds the site and runs the rendered-page check.
- `npm run lint` runs the source linter.

The game does not require Twitch or ChatGPT authentication. Runtime gameplay
uses the public `/api/public-archive` endpoint and browser-local storage only.
