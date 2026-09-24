"""Generate the Android launcher icon from the iOS app icon (requires Pillow).

The iOS icon is a dark square with a centred glyph, so it becomes the full-bleed foreground of an
adaptive icon over its own background colour; the glyph alone becomes the monochrome layer that
Android 13+ tints for themed icons. Rerun after changing ios/.../AppIcon.png.
"""
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'ios/OmarchyRemote/Assets.xcassets/AppIcon.appiconset/AppIcon.png'
RES = ROOT / 'android/app/src/main/res'
# Adaptive icon layers are 108 dp square.
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


INSET = 0.78


def inset(image, fill):
    canvas = Image.new(image.mode, image.size, fill)
    size = round(image.width * INSET)
    offset = (image.width - size) // 2
    canvas.paste(image.resize((size, size), Image.LANCZOS), (offset, offset))
    return canvas


def main():
    icon = Image.open(SOURCE).convert('RGB')
    background = icon.getpixel((8, 8))
    # The glyph is every pixel that differs clearly from the background.
    difference = ImageChops.difference(icon, Image.new('RGB', icon.size, background))
    glyph = difference.convert('L').point(lambda value: min(255, value * 4))
    white = Image.new('RGBA', icon.size, (255, 255, 255, 0))
    white.putalpha(glyph)
    # Launchers mask the 108 dp layer to about 72 dp and keep only a 66 dp circle safe, so the
    # artwork is inset to keep the glyph (its dots reach near the top) inside that circle.
    icon, white = inset(icon, background), inset(white, (255, 255, 255, 0))
    for name, scale in DENSITIES.items():
        size = round(108 * scale)
        folder = RES / f'mipmap-{name}'
        folder.mkdir(parents=True, exist_ok=True)
        icon.resize((size, size), Image.LANCZOS).save(folder / 'ic_launcher_foreground.png', optimize=True)
        white.resize((size, size), Image.LANCZOS).save(folder / 'ic_launcher_monochrome.png', optimize=True)
    values = RES / 'values/ic_launcher_background.xml'
    values.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">#{background[0]:02x}{background[1]:02x}{background[2]:02x}</color>\n'
        '</resources>\n'
    )
    adaptive = RES / 'mipmap-anydpi-v26'
    adaptive.mkdir(exist_ok=True)
    layers = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
        '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />\n'
        '</adaptive-icon>\n'
    )
    for name in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        (adaptive / name).write_text(layers)
    print(f'Wrote Android launcher icons from {SOURCE.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
