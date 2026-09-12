# Privacy policy

Last updated September 12, 2026.

Know The Chat is an unofficial Twitch chat guessing game operated by Harun
Bulut. The public version of this policy is available at
[knowthechat.com/privacy](https://knowthechat.com/privacy). It is not affiliated
with or endorsed by Twitch, Amazon, featured streamers, or the archive and emote
providers it uses.

## Information used by the game

When you start a game, the site processes the Twitch channel name you enter and
publicly available archived chat messages, usernames, badges, timestamps,
profile information, and emote metadata. The site does not ask for a Twitch
login and does not intentionally collect private Twitch messages or
credentials.

## Browser storage

The game stores a per-channel list of previously seen message identifiers in
your browser's local storage to reduce repeated rounds, along with music,
music volume, sound-effect and visual-effects preferences. You can remove this information using your
browser's site-data controls.

A multiplayer room code and session token are stored in the browser tab's
session storage to allow reconnection. Leaving clears the saved player session.
Invite links contain a room code, not this token. Anyone with the room code can
join while the room is accepting players; these are casual private rooms
without Twitch accounts.

## Private multiplayer rooms

Private multiplayer rooms store chosen display names, player-session token
hashes, selected public chat clues, guesses, scores, and timestamps in
Cloudflare Durable Object storage. Other room participants can see display
names, scores, and revealed guesses. Rooms expire after two hours; active room
data is deleted on expiry or when the last participant leaves. Cloudflare
platform backup and recovery retention may outlast application deletion.

Rooms also store the original archive settings and hashes of up to 2,000
recently used quote texts to avoid repeats in rematches. This internal quote
history is not sent to players and is deleted with the room, within its
two-hour lifetime.

## Multiplayer admission controls

To limit repeated room creation, the application derives a SHA-256 hash from
the requesting network's IP address. This is a pseudonymous identifier, not
anonymous data. Admission storage keeps the hash and request time for a
60-second creation window and schedules their deletion when that window ends.
It does not store the unhashed IP address.

Separate admission records contain reservation identifiers and timestamps for
room preparations and new matches, including rematches. These records are
scheduled for deletion after 24 hours. Open-room reservations expire with the
room or are released when it closes; abandoned preparations expire after two
minutes. Cleanup runs on requests and scheduled alarms. Cloudflare platform
backup and recovery retention may outlast application deletion.

## Hosting and operational logs

Cloudflare hosts the site and processes ordinary request data such as IP
addresses, user agents, timestamps, and requested URLs. The application records
operational summaries including the requested channel, selected time range,
result counts, timing, and outcome. It does not intentionally log chat message
bodies or full archives. Cloudflare controls the retention and access settings
for production platform logs.

## External data providers

The application contacts services operated by Twitch, IVR, 7TV, BetterTTV,
FrankerFaceZ, Zonian, and allowlisted public archive providers. These
independent services receive ordinary request metadata and handle information
under their own privacy policies.

## Retention and your choices

Local storage data remains until you clear it. Operational information and
information processed by independent providers are retained according to their
respective settings and policies. You can use browser controls to block or delete cookies and local storage.

## Contact and removal requests

For a privacy, abuse, or project-controlled content-removal request, contact the
maintainer through the [project issue
tracker](https://github.com/Haruzz/knowthechat/issues). Do not include sensitive
or private information in a public issue. Requests about information held by an
independent archive or infrastructure provider must also be
directed to that provider.
