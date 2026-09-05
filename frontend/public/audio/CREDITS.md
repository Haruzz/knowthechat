# Music credits

Music by **Abstraction**, published by Tallbeard Studios in the
[FREE Music Loop Bundle](https://tallbeard.itch.io/music-loop-bundle).
Artist website: <https://abstractionmusic.com/>.

The artist releases the music in this pack under **CC0 1.0 Universal**, permitting
commercial use, redistribution and modification. This applies to the two audio
files below; they retain their CC0 dedication independently of the application's
code license. The complete legal text is in [LICENSE-CC0.txt](LICENSE-CC0.txt).
Source and license were checked on September 5, 2026.

| Game file      | Original track filename               | Duration       | Size          |
| -------------- | ------------------------------------- | -------------- | ------------- |
| `lobby.mp3`    | `Week 1.5 - Super Retro Lounge.ogg`   | 24 seconds     | 394,942 bytes |
| `gameplay.mp3` | `Week 26 - Seaside ENDLESS WAVES.ogg` | 26 2/3 seconds | 442,585 bytes |

These are individual loops from the artist's public preview player. The game
serves its own copies; playback does not contact the artist's site or itch.io.

## Original downloads

- [Super Retro Lounge source OGG](https://html-classic.itch.zone/html/9601284-1755490/media/Scritch/Week%201.5%20-%20Super%20Retro%20Lounge.ogg)
- [Seaside — Endless Waves source OGG](https://html-classic.itch.zone/html/9601284-1755490/media/Scritch/Week%2026%20-%20Seaside%20ENDLESS%20WAVES.ogg)
- [Artist's playlist metadata](https://html-classic.itch.zone/html/9601284-1755490/config.json)
- [CC0 legal text source](https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt)

## Conversion

The complete source loops were converted to stereo MP3 at their original 44,100 Hz
sample rate using `soundfile 0.13.1` / `libsndfile 1.2.2`, variable bitrate and
compression level `0.45`. No passages were cut, repeated or rearranged. The lobby
track's samples were multiplied by `0.8792388021072498` to leave 2 dB of peak
headroom; the gameplay track already had that headroom and its gain was unchanged.

The MP3 files include encoder delay/padding metadata. Decoding the generated files
with libsndfile preserves the original loop lengths exactly: **1,058,400** frames
for the lobby and **1,176,000** for gameplay. No silent padding was added to the
decoded loops. The app uses decoded audio buffers for looping.

To regenerate the files, run from the repository root:

```bash
uv run scripts/prepare-music.py
```

That optional preparation script uses isolated, pinned Python dependencies; it
does not add packages to the application. It verifies the source hashes before
conversion. The existing audio files are included in ordinary frontend builds,
so building or running the game does not require this script or these dependencies.

## SHA-256 checksums

| File                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Original lobby OGG    | `fc84b6b9b0dd8e533b1e7b561ea1ee19899d5784100b4e579c389b99d11745b1` |
| Original gameplay OGG | `39ba6c31b4f8c81cbe40214fb7a57bd2c3281cae2b9b4eeb18f94134c0da8b52` |
| `lobby.mp3`           | `164f5823d07137598bf50f73a6f92d67db0e1f3cd05a2cca2caa066848f0fcdb` |
| `gameplay.mp3`        | `3106ec1fb9aadd04bfdf057a32573d7a87f14a8658c55166d83c3a195714775d` |
