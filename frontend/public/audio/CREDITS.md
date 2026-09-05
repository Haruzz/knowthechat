# Music credits

The music credits are followed by the separate countdown sound-effect credits.

Music by **Abstraction**, published by Tallbeard Studios in the
[FREE Music Loop Bundle](https://tallbeard.itch.io/music-loop-bundle).
Artist website: <https://abstractionmusic.com/>.

The artist releases the music in this pack under **CC0 1.0 Universal**, permitting
commercial use, redistribution and modification. This applies to all five audio
files below; they retain their CC0 dedication independently of the application's
code license. The complete legal text is in [LICENSE-CC0.txt](LICENSE-CC0.txt).
Source titles and license were checked on September 6, 2026.

| Game file                            | Title in the artist's player    | Duration    | Size          |
| ------------------------------------ | ------------------------------- | ----------- | ------------- |
| `lobby.mp3`                          | Week 1.5 Super Retro Lounge     | 24 s        | 394,942 bytes |
| `gameplay-penguin-town.mp3`          | Three Red Hearts - Penguin Town | 35.300703 s | 433,108 bytes |
| `gameplay-sanctuary.mp3`             | Three Red Hearts - Sanctuary    | 76.807370 s | 791,920 bytes |
| `gameplay-sketchbook-2025-12-11.mp3` | Sketchbook 2025-12-11           | 20.869569 s | 381,111 bytes |
| `gameplay-sketchbook-2024-10-14.mp3` | Sketchbook 2024-10-14           | 36.48 s     | 658,775 bytes |

These are complete individual source files from the artist's public preview
player. The game serves its own copies; playback does not contact the artist's
site or itch.io. The lobby audio is unchanged from the original music release.

## Original downloads

- [Week 1.5 - Super Retro Lounge.ogg](https://html-classic.itch.zone/html/9601284-1755490/media/Scritch/Week%201.5%20-%20Super%20Retro%20Lounge.ogg)
- [Three Red Hearts Penguin Town.ogg](https://html-classic.itch.zone/html/9601284-1755490/media/Scritch/Three%20Red%20Hearts%20Penguin%20Town.ogg)
- [Three Red Hearts Sanctuary.ogg](https://html-classic.itch.zone/html/9601284-1755490/media/Scritch/Three%20Red%20Hearts%20Sanctuary.ogg)
- [Sketchbook 2025-12-11_VERSE.ogg](https://html-classic.itch.zone/html/9601284-1755490/media/Scritch/Sketchbook%202025-12-11_VERSE.ogg)
- [Sketchbook 2024-10-14.ogg](https://html-classic.itch.zone/html/9601284-1755490/media/Scritch/Sketchbook%202024-10-14.ogg)
- [Artist's playlist metadata](https://html-classic.itch.zone/html/9601284-1755490/config.json)
- [CC0 legal text source](https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt)

The artist's player labels `Sketchbook 2025-12-11_VERSE.ogg` as
"Sketchbook 2025-12-11". That exact source was used in full, without extracting
or shortening its verse.

## Conversion

The complete source files were converted to stereo MP3 at their original
44,100 Hz sample rate using `soundfile 0.13.1` / `libsndfile 1.2.2`, variable
bitrate and compression level `0.45`. No passages were cut, repeated or
rearranged. Each track's samples were multiplied by the gain below to leave
2 dB of peak headroom.

| Game file                            | Gain                 | Decoded sample frames |
| ------------------------------------ | -------------------- | --------------------- |
| `lobby.mp3`                          | `0.8792388021072498` | 1,058,400             |
| `gameplay-penguin-town.mp3`          | `0.8021728071461931` | 1,556,761             |
| `gameplay-sanctuary.mp3`             | `0.7888079198232699` | 3,387,205             |
| `gameplay-sketchbook-2025-12-11.mp3` | `0.8843828939927703` | 920,348               |
| `gameplay-sketchbook-2024-10-14.mp3` | `0.880723662096379`  | 1,608,768             |

The MP3 files include encoder delay/padding metadata. Decoding the generated
files with libsndfile preserves every original source's sample count exactly.
No silent padding was added to the decoded audio. The app plays decoded audio
buffers.

To regenerate the files, run from the repository root:

```bash
uv run scripts/prepare-music.py
```

That optional preparation script uses isolated, pinned Python dependencies; it
does not add packages to the application. It verifies the source hashes before
conversion. The existing audio files are included in ordinary frontend builds,
so building or running the game does not require this script or these dependencies.

## SHA-256 checksums

| File                                 | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| Original lobby OGG                   | `fc84b6b9b0dd8e533b1e7b561ea1ee19899d5784100b4e579c389b99d11745b1` |
| Original Penguin Town OGG            | `16a7063312bbbabdc449cb847cc040dcdef652d6a1db9385ad5e09ecfafe3753` |
| Original Sanctuary OGG               | `2025ea863cecf0d36bc641a30f30ef99e451ee8cfd02f1be9c7d1d02c4d336f1` |
| Original Sketchbook 2025-12-11 OGG   | `bd591023da07f8d2364ced3cde737eef2e89d50ea47511a1a954dfdcdb69bf48` |
| Original Sketchbook 2024-10-14 OGG   | `7bf6e2d1b7ea7075739d911bae3ba32be0743d78ca76a5c159e7d8e6d0ae15a0` |
| `lobby.mp3`                          | `164f5823d07137598bf50f73a6f92d67db0e1f3cd05a2cca2caa066848f0fcdb` |
| `gameplay-penguin-town.mp3`          | `d6916001a54db12a3c6824b40f956709a63b0055fcc42c5eb449d0735c2a0d7a` |
| `gameplay-sanctuary.mp3`             | `99c45bb1614b825397fb3dba195319950890cd8abb5d9a4c6f340ed05f5cb7d1` |
| `gameplay-sketchbook-2025-12-11.mp3` | `a5af1203178c097b79c066944453a39c29434087e95f6bad8acf30aed73e7bb0` |
| `gameplay-sketchbook-2024-10-14.mp3` | `c7b21318968a2ba6ff86a61c3f194395ada6a3daa3f8b8e3bb04251ef84a5ea9` |

## Countdown clock cues

`countdown-tick.wav` and `countdown-tock.wav` are adapted from **Clock (sound
number 0007)** by **Joseph Sardin**, published by BigSoundBank / LaSonotheque.
The publisher identifies the source as a studio recording of a mechanical clock
and explicitly releases it under **CC0**, permitting modification, redistribution
and commercial use. Source and license were checked on September 6, 2026.

- [Clock source page and CC0 declaration](https://bigsoundbank.com/clock-s0007.html)
- [Original WAV download](https://bigsoundbank.com/UPLOAD/bwf-en/0007.wav)
- [Publisher's license information](https://bigsoundbank.com/licenses.html)
- [Full CC0 legal text](LICENSE-CC0.txt)

These are two consecutive recorded mechanical strokes, not synthesized notes.
The tick uses source seconds **2.20–2.44**; the tock uses **3.20–3.44**. Each
excerpt has DC offset removed, a 2 ms opening fade and a 12 ms closing fade,
then peak normalization to **-2 dBFS**. There is no pitch or speed change.
Both files contain **10,584 mono frames at 44,100 Hz**, lasting **0.24 seconds**,
in PCM16 WAV format. Each file is **21,212 bytes**.

To reproduce only these cues without modifying the music files:

```bash
uv run scripts/prepare-countdown.py
```

The preparation script checks the original download's hash before processing
and uses the same isolated, pinned audio dependencies as the music script.
The sound-effect files are served locally with the frontend.

| File                 | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Original clock WAV   | `f7bffc8e48d7e4fb93e6227e227921d98ab2ecfece733dbd77270bc5fc8e6779` |
| `countdown-tick.wav` | `ca62b0ab4d1bf38a41d7c0d2a4b84f0aa0f8548d808b185ff1c932770455fe57` |
| `countdown-tock.wav` | `008f51b0be7b482f7f0bdd8f2a206fec166a00d1b96e9d03512a5057d59b3a42` |
