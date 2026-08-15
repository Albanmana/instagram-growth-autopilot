"""Generate Cold DM - Sender toolbar icons."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ACCENT = (23, 113, 79, 255)
ROOT = Path(__file__).resolve().parents[1]

for size in (16, 48, 128):
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = max(2, size // 5)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=ACCENT)

    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", int(size * 0.62))
    except OSError:
        font = ImageFont.load_default()

    draw.text((size / 2, size / 2 - size * 0.04), "C", font=font, fill="white", anchor="mm")
    image.save(ROOT / f"extension/assets/icon{size}.png")

print("icons written")
