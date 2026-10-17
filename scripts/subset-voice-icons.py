# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.61.1", "brotli==1.2.0"]
# ///
"""Regenerate the checked-in four-glyph font: uv run scripts/subset-voice-icons.py."""
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from urllib.request import urlopen

from fontTools import subset
from fontTools.ttLib import TTFont

SOURCE = "https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/NerdFontsSymbolsOnly/SymbolsNerdFont-Regular.ttf"
SHA256 = "71db104aa66567d0efe0b98758f9dfc1895573a453fe85fb53d1c38544a55106"
TARGET = Path(__file__).resolve().parent.parent / "src/Strife.Desktop/wwwroot/assets/fonts/strife-voice.woff2"

with urlopen(SOURCE, timeout=30) as response:
    source = response.read()
if sha256(source).hexdigest() != SHA256:
    raise ValueError("Nerd Fonts source checksum mismatch")

font = TTFont(BytesIO(source), recalcTimestamp=False)
options = subset.Options()
options.flavor = "woff2"
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=[0xF02CB, 0xF036C, 0xF036D, 0xF07CE])
subsetter.subset(font)
font.flavor = "woff2"
TARGET.parent.mkdir(parents=True, exist_ok=True)
font.save(TARGET)
print(f"{TARGET.name}: {TARGET.stat().st_size} bytes")
