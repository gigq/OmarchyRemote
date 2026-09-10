"""Package the shared prototype for WKWebView file loading. No network dependencies."""
import argparse
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parent.parent


def prepare(output):
    output = output.resolve()
    # Only write into the dedicated generated Web directory.
    if output.name != "Web":
        raise ValueError("Output directory must be named Web")
    output.mkdir(parents=True, exist_ok=True)
    expected = {file.relative_to(ROOT / "public") for file in (ROOT / "public").rglob("*") if file.is_file()}
    expected.add(Path("native.css"))
    for previous in output.rglob("*"):
        if previous.is_file() and previous.relative_to(output) not in expected:
            previous.unlink()
    shutil.copytree(ROOT / "public", output, dirs_exist_ok=True)
    page = (output / "index.html").read_text()
    page = re.sub(r'((?:src|href)=")/(?!/)', r'\1./', page)
    page = page.replace('url("/', 'url("./').replace("url('/", "url('./")
    page = page.replace('<html lang="en">', '<html lang="en" class="native-shell">')
    page = page.replace('<link rel="manifest" href="./manifest.webmanifest">', '')
    page = page.replace('<script src="./pwa.js" defer></script>', '<script>window.__HYPRLAND_NATIVE__ = true;</script>\n<script src="./pwa.js" defer></script>\n<link rel="stylesheet" href="./native.css">')
    page = page.replace('PWA · start swipes inside the screen', 'swipe again at the edge → iOS')
    (output / "index.html").write_text(page)
    pwa = (output / "pwa.js").read_text().replace("if (!window.__HYPRLAND_DEV__", "if (!window.__HYPRLAND_NATIVE__ && !window.__HYPRLAND_DEV__")
    (output / "pwa.js").write_text(pwa)
    shutil.copyfile(ROOT / "ios/WebOverrides/native.css", output / "native.css")
    print(f"Prepared bundled web assets at {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "ios/Generated/Web")
    prepare(parser.parse_args().output)
