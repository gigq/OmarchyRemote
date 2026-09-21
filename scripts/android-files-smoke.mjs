// Real Android pickers and the live Files app; all host/device files are QA-owned.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(x => /^emulator-\d+\s+device$/.test(x.trim()))
  .map(x => x.split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'This fixture runs only on an emulator');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
adb(
  'shell',
  'am',
  'start',
  '-W',
  '-a',
  'android.intent.action.MAIN',
  '-c',
  'android.intent.category.LAUNCHER',
  '-f',
  '0x10200000',
  '-n',
  'dev.omarchy.remote/.ShellActivity'
);
adb(
  'forward',
  'tcp:9225',
  `localabstract:webview_devtools_remote_${adb('shell', 'pidof', 'dev.omarchy.remote')}`
);
const evaluate = expression =>
  JSON.parse(
    execFileSync(process.execPath, ['scripts/android-cdp.mjs', expression], { encoding: 'utf8' })
  ).result.value;
async function until(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw Error('Android Files condition timed out');
}
function ui() {
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/files-qa.xml');
  } catch (e) {
    if (!e.stdout?.includes('dumped to:')) throw e;
  }
  return adb('shell', 'cat', '/sdcard/files-qa.xml');
}
function native(match, long = false) {
  const node = ui()
    .match(/<node\b[^>]*>/g)
    ?.find(match);
  assert.ok(node, 'Native picker control exists');
  const b = node
    .match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    .slice(1)
    .map(Number);
  const x = String(Math.round((b[0] + b[2]) / 2)),
    y = String(Math.round((b[1] + b[3]) / 2));
  if (long) adb('shell', 'input', 'swipe', x, y, x, y, '800');
  else adb('shell', 'input', 'tap', x, y);
}
async function tap(label) {
  const target = `[...document.querySelectorAll('#remote-files-app button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)} || b.textContent.trim()===${JSON.stringify(label)})`;
  let r,
    last,
    stable = 0;
  await until(() => {
    r = evaluate(
      `(()=>{const node=${target};if(!node)return null;const b=node.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,width:innerWidth,visible:node.checkVisibility()}})()`
    );
    const current = JSON.stringify(r);
    stable = current === last ? stable + 1 : 0;
    last = current;
    return r?.visible && r.x > 0 && r.x < r.width && stable >= 4;
  });
  const width = Number(
    adb('shell', 'wm', 'size').match(/(?:Override|Physical) size: (\d+)x\d+\s*$/)[1]
  );
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round((r.x * width) / r.width)),
    String(Math.round((r.y * width) / r.width))
  );
}
await until(() => evaluate('!!window.HyprlandDesk'));
assert.deepEqual(
  evaluate('JSON.parse(localStorage.getItem("omarchy-layout-phone"))?.open || ["home"]'),
  ['home'],
  'Start with only Home open'
);
const keys = ['omarchy-files-path', 'omarchy-files-mode', 'omarchy-files-recents'];
const previous = evaluate(
  `Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,localStorage.getItem(k)]))`
);
const dir = mkdtempSync(path.join(homedir(), 'android-files-qa-'));
const prefix = 'android-files-' + Date.now();
const files = [
  { name: prefix + '-one.txt', data: 'First Android upload\n' },
  { name: prefix + '-two.txt', data: 'Second Android upload\n' },
];
const archive = prefix + '.zip';
try {
  for (const file of files) {
    const source = path.join(dir, file.name + '.source');
    writeFileSync(source, file.data);
    adb('push', source, '/sdcard/Download/' + file.name);
    rmSync(source);
    adb(
      'shell',
      'am',
      'broadcast',
      '-a',
      'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
      '-d',
      'file:///sdcard/Download/' + file.name
    );
  }
  evaluate(
    `HyprlandUtil.storage.set('omarchy-files-path',${JSON.stringify(dir)});HyprlandUtil.storage.write('omarchy-files-mode','browse')`
  );
  adb(
    'shell',
    'input',
    'keycombination',
    'KEYCODE_CTRL_LEFT',
    'KEYCODE_ALT_LEFT',
    'KEYCODE_SHIFT_LEFT',
    'KEYCODE_F'
  );
  await until(() =>
    evaluate(`document.querySelector('.files-path')?.dataset.path===${JSON.stringify(dir)}`)
  );
  await tap('Upload files');
  await until(() => ui().includes('com.google.android.documentsui'));
  native(n => n.includes('content-desc="Show roots"'));
  native(n => n.includes('text="Downloads"'));
  await until(() => ui().includes(files[0].name));
  native(n => n.includes('text="' + files[0].name + '"'), true);
  native(n => n.includes('text="' + files[1].name + '"'));
  native(n => n.includes('text="SELECT"') || n.includes('text="Select"'));
  await until(() => files.every(f => existsSync(path.join(dir, f.name))));
  for (const f of files) assert.equal(readFileSync(path.join(dir, f.name), 'utf8'), f.data);
  // Cancel another upload and verify it does not create or alter files.
  await tap('Upload files');
  await until(() => ui().includes('com.google.android.documentsui'));
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await until(() =>
    adb('shell', 'dumpsys', 'window')
      .match(/mCurrentFocus=.*$/m)?.[0]
      ?.includes('dev.omarchy.remote')
  );
  assert.deepEqual(readdirSync(dir).sort(), files.map(f => f.name).sort());
  for (const f of files) assert.equal(readFileSync(path.join(dir, f.name), 'utf8'), f.data);
  await tap('Select files');
  for (const f of files) await tap(f.name);
  await tap('Get selected');
  await tap('Save…');
  await until(() => ui().includes('Save to device'));
  native(n => n.includes('text="Save to device"'));
  await until(() => ui().includes('com.google.android.documentsui'));
  native(n => n.includes('class="android.widget.EditText"'));
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
  adb('shell', 'input', 'text', archive);
  native(n => n.includes('text="SAVE"') || n.includes('text="Save"'));
  await until(
    () => adb('shell', `if test -f /sdcard/Download/${archive}; then echo ready; fi`) === 'ready'
  );
  // Creating the destination precedes the native background copy; wait for its acknowledgment.
  await until(() => evaluate('!document.querySelector("#remote-files-app .files-dialog")'));
  adb('pull', '/sdcard/Download/' + archive, path.join(dir, archive));
  const contents = JSON.parse(
    execFileSync(
      'python',
      [
        '-c',
        'import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))',
        path.join(dir, archive),
      ],
      { encoding: 'utf8' }
    )
  );
  assert.deepEqual(
    contents,
    Object.fromEntries(files.map(f => [path.basename(dir) + '/' + f.name, f.data]))
  );
  console.log(
    'PASS: real multi-file picker upload, upload cancellation, selection ZIP save, and exact round-trip contents'
  );
} catch (error) {
  writeFileSync(
    'artifacts/android/files-failure.png',
    execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
      maxBuffer: 16 * 1024 * 1024,
    })
  );
  console.error(ui());
  throw error;
} finally {
  try {
    if (
      adb('shell', 'dumpsys', 'window')
        .match(/mCurrentFocus=.*$/m)?.[0]
        ?.includes('documentsui')
    )
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    evaluate('HyprlandDesk.nativeKey({code:"KeyW",meta:true})');
    await until(() => !evaluate('!!document.querySelector("#remote-files-app .files-heading")'));
    evaluate(
      `Object.entries(${JSON.stringify(previous)}).forEach(([k,v])=>HyprlandUtil.storage.set(k,v))`
    );
  } finally {
    for (const name of [...files.map(f => f.name), archive])
      adb('shell', 'rm', '-f', '/sdcard/Download/' + name);
    rmSync(dir, { recursive: true, force: true });
  }
}
