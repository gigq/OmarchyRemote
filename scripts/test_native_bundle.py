import importlib.util
from pathlib import Path
import re
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("prepare_native", Path(__file__).with_name("prepare-native.py"))
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class NativeBundleTests(unittest.TestCase):
    def test_file_resources_resolve_and_pwa_source_is_preserved(self):
        original = (PREPARE.ROOT / "public/index.html").read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "Web"
            PREPARE.prepare(output)
            page = (output / "index.html").read_text()
            references = re.findall(r'(?:src|href)="([^"{}]+)"', page)
            references += re.findall(r'url\("([^"{}]+)"\)', page)
            self.assertGreater(len(references), 10)
            for reference in references:
                self.assertTrue(reference.startswith("./"), reference)
                self.assertTrue((output / reference).is_file(), reference)
            self.assertIn('class="native-shell"', page)
            self.assertNotIn('rel="manifest"', page)
            self.assertIn('window.__HYPRLAND_NATIVE__ = true', page)
            self.assertIn("!window.__HYPRLAND_NATIVE__", (output / "pwa.js").read_text())
            self.assertEqual((PREPARE.ROOT / "public/index.html").read_bytes(), original)

    def test_rejects_unexpected_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                PREPARE.prepare(Path(directory))


if __name__ == "__main__":
    unittest.main()
