# Makes the app icons from icons/wigwam-source.webp (a wigwam on a transparent background).
# Needs Pillow (pip install pillow).   Usage: python scripts/make-icons.py
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / 'icons'
SKY = (205, 234, 247, 255)

src = Image.open(ICONS / 'wigwam-source.webp').convert('RGBA')
src = src.crop(src.getbbox())

def place(size, width, bg):
    """The wigwam, `width` of the canvas wide, centred on `bg` (None = transparent)."""
    im = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    w = round(size * width); h = round(src.height * w / src.width)
    im.alpha_composite(src.resize((w, h), Image.LANCZOS), ((size - w) // 2, (size - h) // 2 + round(size * 0.015)))
    return im

# Home-screen icons: kept inside the middle 80% so round or squircle masks don't clip it.
for size in (180, 192, 512):
    place(size, 0.72, SKY).convert('RGB').save(ICONS / f'icon-{size}.png', optimize=True)
# Browser-tab icon: no background, as big as it fits.
place(64, 1.0, None).save(ICONS / 'favicon.png', optimize=True)
# Android adaptive icon foreground (432px = 108dp at xxxhdpi). Launchers show only the
# middle 72dp, so the wigwam is kept to half the canvas.
place(432, 0.5, None).save(ROOT / 'android/res/mipmap-xxxhdpi/ic_launcher_foreground.png', optimize=True)
print('Wrote', ', '.join(p.name for p in sorted(ICONS.glob('*.png'))))
