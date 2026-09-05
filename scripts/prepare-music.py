# /// script
# requires-python = ">=3.13"
# dependencies = ["soundfile==0.13.1", "numpy==2.4.3"]
# ///
"""Rebuild the two CC0 music assets with `uv run scripts/prepare-music.py`."""

import hashlib
import io
from pathlib import Path
from urllib.request import urlopen

import numpy as np
import soundfile as sf


SOURCES = {
    "lobby": (
        "https://html-classic.itch.zone/html/9601284-1755490/media/Scritch/"
        "Week%201.5%20-%20Super%20Retro%20Lounge.ogg",
        "fc84b6b9b0dd8e533b1e7b561ea1ee19899d5784100b4e579c389b99d11745b1",
    ),
    "gameplay": (
        "https://html-classic.itch.zone/html/9601284-1755490/media/Scritch/"
        "Week%2026%20-%20Seaside%20ENDLESS%20WAVES.ogg",
        "39ba6c31b4f8c81cbe40214fb7a57bd2c3281cae2b9b4eeb18f94134c0da8b52",
    ),
}


def main() -> None:
    destination = Path(__file__).resolve().parent.parent / "frontend/public/audio"
    destination.mkdir(parents=True, exist_ok=True)
    print(f"soundfile {sf.__version__}; libsndfile {sf.__libsndfile_version__}")
    for role, (url, expected_hash) in SOURCES.items():
        with urlopen(url, timeout=30) as response:
            original = response.read(10 * 1024 * 1024 + 1)
        if len(original) > 10 * 1024 * 1024:
            raise ValueError(f"Source for {role} exceeds 10 MiB")
        if hashlib.sha256(original).hexdigest() != expected_hash:
            raise ValueError(f"Source for {role} has changed; review before replacing")
        data, sample_rate = sf.read(io.BytesIO(original), always_2d=True)
        peak = float(np.max(np.abs(data)))
        gain = min(1.0, 10 ** (-2 / 20) / peak)
        data *= gain
        output = destination / f"{role}.mp3"
        sf.write(
            output,
            data,
            sample_rate,
            format="MP3",
            bitrate_mode="VARIABLE",
            compression_level=0.45,
        )
        decoded, decoded_rate = sf.read(output, always_2d=True)
        if decoded_rate != sample_rate or decoded.shape != data.shape:
            raise ValueError(f"The encoded {role} loop has different sample timing")
        print(
            role,
            {
                "samples": len(data),
                "sample_rate": sample_rate,
                "duration": len(data) / sample_rate,
                "gain": gain,
                "bytes": output.stat().st_size,
                "source_sha256": hashlib.sha256(original).hexdigest(),
                "mp3_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                "source_boundary": float(np.max(np.abs(data[-1] - data[0]))),
                "mp3_boundary": float(np.max(np.abs(decoded[-1] - decoded[0]))),
            },
        )


if __name__ == "__main__":
    main()
