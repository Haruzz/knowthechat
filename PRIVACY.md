# Privacy and public-data notice

Know The Chat is an unofficial Twitch chat guessing game. It is not affiliated
with or endorsed by Twitch, Amazon, the streamers listed in the project, or the
third-party archive and emote providers it uses.

## Data processed

When a player starts a game, the application processes:

- The Twitch channel name selected by the player.
- Publicly available archived chat messages, usernames, badges, and timestamps.
- Public Twitch profile and third-party emote metadata.

The application does not ask for a Twitch login and does not intentionally
collect private chat messages or Twitch credentials.

The production Worker logs operational request summaries such as the requested
channel, selected time range, result counts, timing, and outcome. It does not
intentionally log chat message bodies or full archives. Cloudflare controls the
retention and access settings for production platform logs.

The browser stores a per-channel list of previously seen message identifiers in
local storage to reduce repeated rounds. Players can remove this data through
their browser's site-data controls.

## External services

The application contacts public services operated by Twitch, IVR, 7TV,
BetterTTV, FrankerFaceZ, Zonian, and allowlisted public archive instances. Those
services receive ordinary request metadata such as the player's or Worker's IP
address and user agent and operate under their own terms and privacy policies.

## Removal and abuse requests

To request removal of a project-maintained link, attribution, or other content,
open a GitHub issue identifying the affected channel and the requested action.
Do not reproduce sensitive content in the issue. The project cannot delete data
held by independent archive providers; requests concerning their underlying
archives must be directed to those providers.
