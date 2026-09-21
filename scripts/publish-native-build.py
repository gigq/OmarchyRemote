#!/usr/bin/env python3
"""Publish an already signed/validated iOS IPA or Android APK to the private build download page."""
import argparse
import datetime
import fcntl
import hashlib
import html
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
from urllib.parse import quote, urlsplit
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def atomic_write(path, content):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        out.write(content)
        temporary = Path(out.name)
    temporary.replace(path)


def publish(ipa, destination, base_url, notes, commit):
    url = urlsplit(base_url)
    if url.scheme != 'https' or not url.netloc or url.query or url.fragment or url.username:
        raise ValueError('Use an absolute HTTPS base URL without credentials, query or fragment')
    base_url = base_url.rstrip('/')
    digest = hashlib.sha256(ipa.read_bytes()).hexdigest()
    android = ipa.suffix.lower() == '.apk'
    if android:
        sdk = Path(os.environ.get('ANDROID_HOME', os.environ.get('ANDROID_SDK_ROOT', '')))
        candidates = sorted((sdk / 'build-tools').glob('*'),
                            key=lambda p: tuple(int(n) for n in re.findall(r'\d+', p.name)), reverse=True)
        def tool(name):
            found = shutil.which(name)
            if found:
                return found
            for folder in candidates:
                if (folder / name).is_file():
                    return str(folder / name)
            raise ValueError(f'Install Android SDK build-tools and set ANDROID_HOME ({name} missing)')
        verified = subprocess.run([tool('apksigner'), 'verify', '--print-certs', str(ipa)],
                                  capture_output=True, text=True, check=True).stdout
        certs = re.findall(r'certificate SHA-256 digest: ([a-fA-F0-9]{64})', verified)
        if not certs:
            raise ValueError('APK signing certificate unavailable')
        badging = subprocess.run([tool('aapt'), 'dump', 'badging', str(ipa)],
                                capture_output=True, text=True, check=True).stdout
        package = re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'", badging)
        sdk_match = re.search(r"^sdkVersion:'(\d+)'", badging, re.MULTILINE)
        if not package or not sdk_match:
            raise ValueError('APK package, version, or minimum SDK missing')
        identifier, build, version = package.groups()
        expires = None
        info = {}
    else:
        with zipfile.ZipFile(ipa) as archive:
            roots = [name for name in archive.namelist()
                     if name.startswith('Payload/') and name.endswith('.app/Info.plist')
                     and name.count('/') == 2]
            if len(roots) != 1:
                raise ValueError('Expected exactly one main iOS app')
            info = plistlib.loads(archive.read(roots[0]))
            if info.get('DTPlatformName') != 'iphoneos':
                raise ValueError('Expected a physical iOS build')
            profile_data = archive.read(roots[0].replace('Info.plist', 'embedded.mobileprovision'))
        decoded = subprocess.run(
            ['openssl', 'cms', '-verify', '-inform', 'DER', '-noverify'],
            input=profile_data, capture_output=True, check=True)
        profile = plistlib.loads(decoded.stdout)
        expires = profile['ExpirationDate'].replace(tzinfo=datetime.timezone.utc)
        if expires <= datetime.datetime.now(datetime.timezone.utc):
            raise ValueError('Provisioning profile expired; build a newly signed IPA')
        build = str(info['CFBundleVersion'])
        version = str(info['CFBundleShortVersionString'])
        identifier = info['CFBundleIdentifier']
    key = digest
    entry = dict(id=key, build=build, version=version, sha256=digest,
                 bytes=ipa.stat().st_size, notes=notes, commit=commit,
                 published=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 platform='android' if android else 'ios', identifier=identifier,
                 expires=expires.date().isoformat() if expires else None,
                 devices=[name for number, name in [(1, 'iPhone'), (2, 'iPad')]
                          if number in info.get('UIDeviceFamily', [])])
    filename = 'app.apk' if android else 'app.ipa'
    if android:
        entry.update(devices=['Android'], min_sdk=int(sdk_match[1]), signing_certificates=certs)
    destination.mkdir(parents=True, exist_ok=True)
    with (destination / '.publish.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        catalog_path = destination / 'catalog.json'
        catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else []
        previous = next((item for item in catalog if item['id'] == key), None)
        if previous:
            entry['published'] = previous['published']
        folder = destination / key
        folder.mkdir(exist_ok=True)
        if not (folder / filename).exists():
            temporary = folder / ('.' + filename + '.tmp')
            shutil.copyfile(ipa, temporary)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
                raise ValueError('Artifact changed during publication')
            temporary.replace(folder / filename)
        elif hashlib.sha256((folder / filename).read_bytes()).hexdigest() != digest:
            raise ValueError('Retained artifact checksum mismatch')
        manifest = {'items': [{'assets': [{'kind': 'software-package',
                                          'url': f'{base_url}/{key}/app.ipa'}],
                               'metadata': {'bundle-identifier': identifier,
                                            'bundle-version': build,
                                            'kind': 'software',
                                            'title': info.get('CFBundleDisplayName', 'Omarchy Remote')}}]}
        if not android:
            atomic_write(folder / 'manifest.plist', plistlib.dumps(manifest))
        catalog = [entry] + [item for item in catalog if item['id'] != key]
        cards = []
        esc = html.escape
        for index, item in enumerate(catalog):
            href = f"{base_url}/{item['id']}/manifest.plist"
            install = 'itms-services://?action=download-manifest&url=' + quote(href, safe='')
            is_android = item.get('platform') == 'android'
            extension = 'apk' if is_android else 'ipa'
            if is_android:
                install = f"{item['id']}/app.apk"
            install_link = '' if is_android else f'<a class="install" href="{esc(install)}">Install on device <span aria-hidden="true">↗</span></a>'
            expiry_label = 'Minimum Android API' if is_android else 'Profile expires'
            expiry = str(item.get('min_sdk', '')) if is_android else item['expires']
            cards.append(f'''<article class="build">
<p class="eyebrow">{'Latest build' if index == 0 else 'Previous build'} · {esc(' / '.join(item['devices']))}</p>
<div class="build-heading"><h2>Build {esc(item['build'])}</h2><span class="version">v{esc(item['version'])}</span></div>
<p class="notes">{esc(item['notes'])}</p>
<div class="actions">{install_link}
<a class="download" href="{item['id']}/app.{extension}" download>Download {extension.upper()} · {item['bytes'] / 1048576:.1f} MB</a></div>
<dl><div><dt>Published</dt><dd>{esc(item['published'][:10])}</dd></div>
<div><dt>{expiry_label}</dt><dd>{esc(expiry)}</dd></div>
<div><dt>Source</dt><dd><code>{esc(item['commit'][:12])}</code></dd></div></dl>
<details><summary>SHA-256 checksum</summary><code class="hash">{item['sha256']}</code></details>
</article>''')
        template = (ROOT / 'deploy/builds-template.html').read_text()
        page = template.replace('<!-- BUILD_CARDS -->', '\n'.join(cards))
        atomic_write(destination / 'SKILL.md', (ROOT / 'skills/omarchy-builds/SKILL.md').read_bytes())
        atomic_write(catalog_path, (json.dumps(catalog, indent=2) + '\n').encode())
        atomic_write(destination / 'index.html', page.encode())
    return entry


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa', type=Path)
    parser.add_argument('--base-url', default=os.environ.get('OMARCHY_DOWNLOAD_BASE_URL'),
                        help='Private HTTPS URL ending in /builds (or OMARCHY_DOWNLOAD_BASE_URL)')
    parser.add_argument('--directory', type=Path, default=Path(os.environ.get(
        'OMARCHY_BUILDS_DIR', str(Path.home() / '.local/share/omarchy-remote/builds'))))
    parser.add_argument('--notes', required=True)
    parser.add_argument('--commit', required=True, help='Commit used to build the artifact')
    args = parser.parse_args()
    if not args.base_url:
        parser.error('Set --base-url or OMARCHY_DOWNLOAD_BASE_URL')
    result = publish(args.ipa, args.directory, args.base_url, args.notes, args.commit)
    print(f"Published build {result['build']} at {args.base_url.rstrip('/')}/")
    print(f"SHA-256: {result['sha256']}")
