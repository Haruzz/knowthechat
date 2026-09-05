# /// script
# requires-python = ">=3.13"
# dependencies = ["soundfile==0.13.1", "numpy==2.4.3"]
# ///
"""Extract the recorded CC0 clock cues with `uv run scripts/prepare-countdown.py`."""

import hashlib
import io
from pathlib import Path
from urllib.request import urlopen

import numpy as np
import soundfile as sf


SOURCE_URL = "https://bigsoundbank.com/UPLOAD/bwf-en/0007.wav"
SOURCE_SHA256 = "f7bffc8e48d7e4fb93e6227e227921d98ab2ecfece733dbd77270bc5fc8e6779"
# Adjacent mechanical strokes from the original nine-second recording.
SEGMENTS = {"tick": (2.20, 2.44), "tock": (3.20, 3.44)}


def main() -> None:
    with urlopen(SOURCE_URL, timeout=30) as response:
        original = response.read(2 * 1024 * 1024 + 1)
    if len(original) > 2 * 1024 * 1024:
        raise ValueError("Clock source exceeds 2 MiB")
    if hashlib.sha256(original).hexdigest() != SOURCE_SHA256:
        raise ValueError("Clock source has changed; review before replacing")
    recording, sample_rate = sf.read(io.BytesIO(original), always_2d=True)
    if sample_rate != 44100 or recording.shape[1] != 1:
        raise ValueError("Expected the original mono 44.1 kHz clock recording")
    destination = Path(__file__).resolve().parent.parent / "frontend/public/audio"
    destination.mkdir(parents=True, exist_ok=True)
    for name, (start, end) in SEGMENTS.items():
        cue = recording[round(start * sample_rate) : round(end * sample_rate)].copy()
        cue -= cue.mean(axis=0)
        fade_in = round(0.002 * sample_rate)
        fade_out = round(0.012 * sample_rate)
        cue[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
        cue[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
        cue *= 10 ** (-2 / 20) / np.max(np.abs(cue))
        output = destination / f"countdown-{name}.wav"
        sf.write(output, cue, sample_rate, subtype="PCM_16")
        decoded, decoded_rate = sf.read(output, always_2d=True)
        if decoded_rate != sample_rate or decoded.shape != cue.shape:
            raise ValueError(f"The encoded {name} has different sample timing")
        print(
            name,
            {
                "frames": len(decoded),
                "duration": len(decoded) / sample_rate,
                "peak": float(np.max(np.abs(decoded))),
                "rms": float(np.sqrt(np.mean(decoded**2))),
                "bytes": output.stat().st_size,
                "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            },
        )


if __name__ == "__main__":
    main()
