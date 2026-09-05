# /// script
# requires-python = ">=3.13"
# dependencies = ["soundfile==0.13.1", "numpy==2.4.3"]
# ///
"""Prepare the CC BY 3.0 applause with `uv run scripts/prepare-applause.py`."""

import hashlib
import io
from pathlib import Path
from urllib.request import urlopen

import numpy as np
import soundfile as sf

SOURCE_URL = "https://opengameart.org/sites/default/files/applause.wav"
SOURCE_SHA256 = "d8d44ae50a16ba4218c1861c8fa236c481c2caf56195883edc81f89919fb6958"
MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024


def main() -> None:
    with urlopen(SOURCE_URL, timeout=30) as response:
        original = response.read(MAX_SOURCE_BYTES + 1)
    if len(original) > MAX_SOURCE_BYTES:
        raise ValueError("Applause source exceeds 4 MiB")
    if hashlib.sha256(original).hexdigest() != SOURCE_SHA256:
        raise ValueError("Applause source has changed; review before replacing")

    recording, sample_rate = sf.read(io.BytesIO(original), always_2d=True)
    if sample_rate != 48000 or recording.shape != (366967, 2):
        raise ValueError("Expected the complete stereo 48 kHz applause recording")
    if not np.isfinite(recording).all():
        raise ValueError("Applause recording contains non-finite samples")

    # Keep the entire recording, including its natural opening and closing tails.
    fade_in = round(0.020 * sample_rate)
    fade_out = round(0.150 * sample_rate)
    recording[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
    recording[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
    peak = float(np.max(np.abs(recording)))
    if peak <= 0:
        raise ValueError("Applause recording is silent")
    gain = 10 ** (-2 / 20) / peak
    recording *= gain

    encoded = io.BytesIO()
    sf.write(
        encoded,
        recording,
        sample_rate,
        format="MP3",
        bitrate_mode="VARIABLE",
        compression_level=0.45,
    )
    content = encoded.getvalue()
    if len(content) > MAX_OUTPUT_BYTES:
        raise ValueError("Encoded applause exceeds 1 MiB")
    decoded, decoded_rate = sf.read(io.BytesIO(content), always_2d=True)
    if decoded_rate != sample_rate or decoded.shape != recording.shape:
        raise ValueError("The encoded applause has different sample timing")
    if not np.isfinite(decoded).all() or np.max(np.abs(decoded)) >= 1:
        raise ValueError("The encoded applause contains invalid or clipped samples")

    destination = Path(__file__).resolve().parent.parent / "frontend/public/audio"
    destination.mkdir(parents=True, exist_ok=True)
    output = destination / "applause.mp3"
    output.write_bytes(content)
    print(
        {
            "file": output.name,
            "frames": len(decoded),
            "sample_rate": decoded_rate,
            "duration": len(decoded) / decoded_rate,
            "gain": gain,
            "decoded_peak": float(np.max(np.abs(decoded))),
            "rms": float(np.sqrt(np.mean(decoded**2))),
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        },
    )


if __name__ == "__main__":
    main()
