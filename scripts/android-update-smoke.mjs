// Uses a temporary host and a signed APK for the installed debug app. Confirms a real update.
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(line => /^emulator-\d+\s+device$/.test(line.trim()))
  .map(line => line.trim().split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'Run installation QA on an emulator only');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
function forward() {
  const pid = adb('shell', 'pidof', 'dev.omarchy.remote');
  assert.match(pid, /^\d+$/);
  adb('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`);
}
forward();
const evaluate = expression =>
  JSON.parse(
    execFileSync(process.execPath, ['scripts/android-cdp.mjs', expression], { encoding: 'utf8' })
  ).result.value;
async function until(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('Android update condition did not become true');
}
const xml = () => {
  adb('shell', 'uiautomator', 'dump', '/sdcard/update-qa.xml');
  return adb('shell', 'cat', '/sdcard/update-qa.xml');
};
function tapNode(match) {
  const node = xml()
    .match(/<node\b[^>]*>/g)
    ?.find(match);
  assert.ok(node, 'Expected Android control exists');
  const bounds = node
    .match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    .slice(1)
    .map(Number);
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round((bounds[0] + bounds[2]) / 2)),
    String(Math.round((bounds[1] + bounds[3]) / 2))
  );
}
const log = message => console.log(`UPDATE_QA: ${message}`);
const installerIsTop = () =>
  /topResumedActivity=.*com\.google\.android\.packageinstaller/.test(
    adb('shell', 'dumpsys', 'activity', 'activities')
  );
function dismissInstaller() {
  if (!installerIsTop()) return;
  try {
    if (xml().includes('App installed.')) tapNode(node => node.includes('text="Done"'));
    else adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  } catch {
    adb('shell', 'am', 'force-stop', 'com.google.android.packageinstaller');
  }
}
const apk = readFileSync(
  process.env.ANDROID_UPDATE_APK || 'android/app/build/outputs/apk/debug/app-debug.apk'
);
const hash = createHash('sha256').update(apk).digest('hex');
const sdkRoot = process.env.ANDROID_SDK_ROOT || '/opt/android-sdk';
const installedVersionCode = Number(
  adb('shell', 'dumpsys', 'package', 'dev.omarchy.remote').match(/versionCode=(\d+)/)?.[1]
);
assert.ok(Number.isSafeInteger(installedVersionCode), 'Installed app version code is unavailable');
// Build negative artifacts in a temporary project so the installed app and shared Gradle outputs
// remain untouched. The ephemeral signing key is never printed or retained.
function buildNegativeApks(versionCode) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'android-update-qa-'));
  try {
    const temporaryAndroid = join(temporaryRoot, 'android');
    const copyFilter = source => !/(^|[/\\])(?:build|\.gradle)(?:[/\\]|$)/.test(source);
    cpSync('android', temporaryAndroid, { recursive: true, filter: copyFilter });
    cpSync('public', join(temporaryRoot, 'public'), { recursive: true });
    mkdirSync(join(temporaryRoot, 'ios', 'WebOverrides'), { recursive: true });
    cpSync('ios/WebOverrides/native.css', join(temporaryRoot, 'ios', 'WebOverrides', 'native.css'));
    mkdirSync(join(temporaryRoot, 'scripts'), { recursive: true });
    cpSync('scripts/prepare-native.py', join(temporaryRoot, 'scripts', 'prepare-native.py'));
    const buildEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('OMARCHY_ANDROID_'))
    );
    const build = applicationId => {
      execFileSync(
        join(temporaryAndroid, 'gradlew'),
        [
          '--no-daemon',
          '--offline',
          '--project-cache-dir',
          join(temporaryRoot, 'gradle-cache'),
          ':app:clean',
          ':app:assembleDebug',
          `-PapplicationId=${applicationId}`,
          `-PversionCode=${versionCode}`,
          '-PversionName=update-qa',
          '-PremoteUrl=http://127.0.0.1:4187',
        ],
        { cwd: temporaryAndroid, env: buildEnvironment, stdio: 'ignore' }
      );
      return join(temporaryAndroid, 'app/build/outputs/apk/debug/app-debug.apk');
    };
    const wrongPackage = readFileSync(build('dev.omarchy.remote.updateqa'));
    const signedSourcePath = build('dev.omarchy.remote');
    const password = randomBytes(24).toString('hex');
    const signingEnvironment = {
      ...buildEnvironment,
      ANDROID_UPDATE_QA_PASSWORD: password,
    };
    const keystore = join(temporaryRoot, 'wrong-signing-key.jks');
    execFileSync(
      'keytool',
      [
        '-genkeypair',
        '-keystore',
        keystore,
        '-storepass:env',
        'ANDROID_UPDATE_QA_PASSWORD',
        '-keypass:env',
        'ANDROID_UPDATE_QA_PASSWORD',
        '-alias',
        'updateqa',
        '-keyalg',
        'RSA',
        '-keysize',
        '2048',
        '-validity',
        '2',
        '-dname',
        'CN=Temporary Android Update QA',
      ],
      { env: signingEnvironment, stdio: 'ignore' }
    );
    const wrongSigningPath = join(temporaryRoot, 'wrong-signing.apk');
    cpSync(signedSourcePath, wrongSigningPath);
    execFileSync(
      join(sdkRoot, 'build-tools/36.0.0/apksigner'),
      [
        'sign',
        '--ks',
        keystore,
        '--ks-key-alias',
        'updateqa',
        '--ks-pass',
        'env:ANDROID_UPDATE_QA_PASSWORD',
        '--key-pass',
        'env:ANDROID_UPDATE_QA_PASSWORD',
        wrongSigningPath,
      ],
      { env: signingEnvironment, stdio: 'ignore' }
    );
    return {
      wrongPackage,
      wrongSigning: readFileSync(wrongSigningPath),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
const negativeApks = buildNegativeApks(installedVersionCode + 1);
const builds = new Map([[hash, apk]]);
const addBuild = bytes => {
  const id = createHash('sha256').update(bytes).digest('hex');
  builds.set(id, bytes);
  return id;
};
const wrongPackageHash = addBuild(negativeApks.wrongPackage);
const wrongSigningHash = addBuild(negativeApks.wrongSigning);
assert.notEqual(wrongPackageHash, hash);
assert.notEqual(wrongSigningHash, hash);
assert.notEqual(wrongPackageHash, wrongSigningHash);
const server = createServer((req, res) => {
  if (req.url.startsWith('/builds/')) {
    const buildHash = req.url.split('/')[2];
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.end(builds.get(buildHash) || apk);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><title>Update QA host</title><h1>Update QA</h1>'
    );
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
adb('reverse', `tcp:${port}`, `tcp:${port}`);
const host = `http://127.0.0.1:${port}/native/`;
const original = evaluate('window.webkit.messageHandlers.shellHosts.postMessage({action:"list"})');
assert.ok(original.selected && !original.disconnected, 'Start connected to a host');
const hosts = body =>
  evaluate(`window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify(body)})`);
function connect(id) {
  evaluate(
    `void window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'connect', id })})`
  );
}
const install = async id => {
  const expression = `window.webkit.messageHandlers.shellInstallBuild.postMessage({build:${JSON.stringify(id)}}).catch(error=>({error:error.message}))`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    'scripts/android-cdp.mjs',
    expression,
  ]);
  return JSON.parse(stdout).result.value;
};
let primaryError;
try {
  hosts({ action: 'save', name: 'Android update QA', url: host });
  connect(host);
  await until(() => evaluate('location.href') === host);
  assert.match((await install('../bad')).error, /Invalid build identity/);
  log('wrong identity rejected');
  assert.match((await install('0'.repeat(64))).error, /checksum mismatch/);
  log('wrong checksum rejected');
  assert.match((await install(wrongPackageHash)).error, /different app/);
  log('wrong package rejected');
  assert.match((await install(wrongSigningHash)).error, /signing key does not match/);
  log('wrong signing key rejected');
  let result = await install(hash);
  if (result.permissionRequired) {
    await until(() => xml().includes('Allow from this source'));
    // Denying permission must leave the installed app untouched and remain retryable.
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    assert.equal((await install(hash)).permissionRequired, true);
    tapNode(node => node.includes('checkable="true"') && node.includes('clickable="true"'));
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    result = await install(hash);
  }
  assert.equal(result.opened, true, JSON.stringify(result));
  log('valid installer opened');
  await until(() => /text="(Update|Install)"/.test(xml()));
  tapNode(node => node.includes('text="Cancel"'));
  log('installer cancellation completed');
  assert.equal((await install(hash)).opened, true);
  await until(() => /text="(Update|Install)"/.test(xml()));
  const before = adb('shell', 'dumpsys', 'package', 'dev.omarchy.remote').match(
    /lastUpdateTime=(.*)/
  )?.[1];
  tapNode(node => /text="(Update|Install)"/.test(node));
  await until(
    () =>
      adb('shell', 'dumpsys', 'package', 'dev.omarchy.remote').match(/lastUpdateTime=(.*)/)?.[1] !==
      before
  );
  await until(() => xml().includes('App installed.'));
  log('valid APK installed');
  dismissInstaller();
  await until(() => !installerIsTop());
  adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    '-f',
    '0x10200000',
    '-n',
    'dev.omarchy.remote/.ShellActivity'
  );
  await until(() => {
    try {
      forward();
      return evaluate('location.href') === host;
    } catch {
      return false;
    }
  });
  const installedPath = adb('shell', 'pm', 'path', 'dev.omarchy.remote').replace(/^package:/, '');
  assert.equal(adb('shell', 'sha256sum', installedPath).split(/\s+/)[0], hash);
  log('installed APK hash verified');
  console.log(
    'PASS: invalid identity/checksum rejection, permission retry, installer cancellation, confirmed APK update and retained host (permission retry when required)'
  );
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  let cleanupError;
  try {
    dismissInstaller();
    adb(
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-f',
      '0x10200000',
      '-n',
      'dev.omarchy.remote/.ShellActivity'
    );
    await until(() => {
      try {
        forward();
        return true;
      } catch {
        return false;
      }
    });
    await until(() => {
      if (evaluate('location.href') === original.selected) return true;
      connect(original.selected);
      return false;
    });
    hosts({ action: 'remove', id: host });
  } catch (error) {
    cleanupError = error;
    console.error(`UPDATE_QA cleanup warning: ${error.stack || error}`);
  } finally {
    try {
      adb('reverse', '--remove', `tcp:${port}`);
    } catch (error) {
      cleanupError ||= error;
      console.error(`UPDATE_QA reverse cleanup warning: ${error.stack || error}`);
    }
    try {
      server.closeAllConnections();
      server.close();
    } catch (error) {
      cleanupError ||= error;
      console.error(`UPDATE_QA server cleanup warning: ${error.stack || error}`);
    }
  }
  if (cleanupError && !primaryError) throw cleanupError;
}
