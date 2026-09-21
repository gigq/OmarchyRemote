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

    def test_android_publication_verifies_signature_and_keeps_mixed_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            apk = root / 'test.apk'
            apk.write_bytes(b'signed apk fixture')
            output = root / 'downloads'
            output.mkdir()
            legacy = dict(id='a'*64, build='9', version='1', bytes=42, notes='iOS build',
                          devices=['iPhone'], expires='2099-01-01', published='2026-01-01',
                          commit='old', sha256='a'*64)
            (output / 'catalog.json').write_text(json.dumps([legacy]))
            def run(command, **kwargs):
                if 'apksigner' in command[0]:
                    return types.SimpleNamespace(stdout='Signer #1 certificate SHA-256 digest: '+'b'*64)
                return types.SimpleNamespace(stdout="package: name='example.app' versionCode='2' versionName='1.1'\nsdkVersion:'30'\n")
            with patch.object(publisher.shutil, 'which', side_effect=lambda tool: tool), patch.object(publisher.subprocess, 'run', side_effect=run) as verify:
                entry = publisher.publish(apk, output, 'https://example.test/builds', '<test>', 'new')
                self.assertEqual(verify.call_args_list[0].args[0][1:3], ['verify', '--print-certs'])
                self.assertEqual(entry['platform'], 'android')
                self.assertEqual(entry['identifier'], 'example.app')
                self.assertEqual(entry['min_sdk'], 30)
                self.assertEqual((output / entry['id'] / 'app.apk').read_bytes(), apk.read_bytes())
                self.assertFalse((output / entry['id'] / 'manifest.plist').exists())
                self.assertEqual(len(json.loads((output / 'catalog.json').read_text())), 2)
                page = (output / 'index.html').read_text()
                self.assertIn('Download APK', page)
                self.assertIn('itms-services://', page)
                self.assertIn('&lt;test&gt;', page)
            with patch.object(publisher.shutil, 'which', side_effect=lambda tool: tool), patch.object(publisher.subprocess, 'run', side_effect=RuntimeError('invalid signature')):
                with self.assertRaises(RuntimeError):
                    publisher.publish(apk, output, 'https://example.test/builds', '', 'bad')
            self.assertEqual(json.loads((output / 'catalog.json').read_text())[0]['commit'], 'new')
