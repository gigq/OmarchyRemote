import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile
import datetime

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-native-build.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class BuildDownloadsTests(unittest.TestCase):
    def test_publication_preserves_bytes_history_and_escapes_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ipa = root / 'test.ipa'
            info = dict(DTPlatformName='iphoneos', CFBundleVersion='36',
                        CFBundleShortVersionString='1.0', CFBundleIdentifier='example.app',
                        UIDeviceFamily=[1, 2])
            with zipfile.ZipFile(ipa, 'w') as archive:
                archive.writestr('Payload/Test.app/Info.plist', plistlib.dumps(info))
                archive.writestr('Payload/Test.app/embedded.mobileprovision', b'test')
            profile = plistlib.dumps(dict(ExpirationDate=datetime.datetime(2099, 1, 1)))
            output = root / 'downloads'
            with patch.object(publisher.subprocess, 'run', return_value=types.SimpleNamespace(stdout=profile)):
                first = publisher.publish(ipa, output, 'https://example.test/builds', '<script>alert(1)</script>', 'abc123')
                again = publisher.publish(ipa, output, 'https://example.test/builds', 'Updated notes', 'abc123')
                self.assertEqual(first['published'], again['published'])
                self.assertEqual(len(json.loads((output / 'catalog.json').read_text())), 1)
                publisher.publish(ipa, output, 'https://example.test/builds', '<script>alert(1)</script>', 'abc123')
            page = (output / 'index.html').read_text()
            self.assertNotIn('<script>alert', page)
            self.assertIn('&lt;script&gt;', page)
            self.assertIn('itms-services://', page)
            folder = output / first['id']
            self.assertEqual((folder / 'app.ipa').read_bytes(), ipa.read_bytes())
            manifest = plistlib.loads((folder / 'manifest.plist').read_bytes())['items'][0]
            self.assertEqual(manifest['metadata']['bundle-identifier'], 'example.app')
            self.assertEqual(manifest['assets'][0]['url'], f"https://example.test/builds/{first['id']}/app.ipa")
            with self.assertRaises(ValueError):
                publisher.publish(ipa, output, 'http://example.test/builds', '', 'abc123')
