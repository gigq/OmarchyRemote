"""Build and update an isolated release identity with a temporary signing key."""

import json
import os
import pathlib
import re
import secrets
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
SDK = pathlib.Path(os.environ.get("ANDROID_SDK_ROOT", "/opt/android-sdk"))
ADB = str(SDK / "platform-tools/adb")
PACKAGE = "dev.omarchy.remote.releaseqa"
ACTIVITY = PACKAGE + "/dev.omarchy.remote.ShellActivity"
RELEASE_HOST_RAW = os.environ.get("ANDROID_RELEASE_HOST_URL", "").strip()


def run(*args, **kwargs):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, **kwargs
    ).stdout.strip()


def release_endpoint(raw):
    candidate = raw if "://" in raw else "https://" + raw
    parsed = urllib.parse.urlsplit(candidate)
    try:
        _ = parsed.port
    except ValueError as error:
        raise AssertionError("ANDROID_RELEASE_HOST_URL has an invalid port") from error
    assert parsed.scheme == "https" and parsed.hostname, (
        "ANDROID_RELEASE_HOST_URL must be an HTTPS host"
    )
    assert not parsed.username and not parsed.password, (
        "ANDROID_RELEASE_HOST_URL must not contain credentials"
    )
    assert parsed.path in ("", "/", "/native", "/native/"), (
        "ANDROID_RELEASE_HOST_URL must be a host or /native/ URL"
    )
    assert not parsed.query and not parsed.fragment, (
        "ANDROID_RELEASE_HOST_URL must not contain a query or fragment"
    )
    origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    native = origin + "/native/"
    request = urllib.request.Request(
        origin + "/api/capabilities", headers={"X-Hyprland-Client": "1"}
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            capabilities = json.load(response)
    except Exception as error:
        raise AssertionError(
            "ANDROID_RELEASE_HOST_URL must serve the Omarchy capabilities endpoint"
        ) from error
    host = capabilities.get("host")
    assert isinstance(host, str) and host.strip(), (
        "The release host capabilities response must include a host name"
    )
    return native, host.strip()


if RELEASE_HOST_RAW:
    RELEASE_HOST_URL, RELEASE_HOST_NAME = release_endpoint(RELEASE_HOST_RAW)
else:
    RELEASE_HOST_URL = ""
    RELEASE_HOST_NAME = ""


devices = re.findall(r"^(emulator-\d+)\s+device$", run(ADB, "devices"), re.M)
serial = os.environ.get("ANDROID_SERIAL", devices[0] if len(devices) == 1 else "")
assert re.fullmatch(r"emulator-\d+", serial), "Select one emulator"


def adb(*args):
    return run(ADB, "-s", serial, *args)


assert not adb("shell", "pm", "list", "packages", PACKAGE), (
    "Release QA identity must not already be installed"
)


def ui():
    result = subprocess.run(
        [ADB, "-s", serial, "shell", "uiautomator", "dump", "/sdcard/release-qa.xml"],
        capture_output=True,
        text=True,
    )
    if result.returncode and "dumped to:" not in result.stdout:
        raise RuntimeError("Could not read Android UI")
    return ET.fromstring(adb("shell", "cat", "/sdcard/release-qa.xml"))


def until(check):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        result = check()
        if isinstance(result, ET.Element) or result:
            return result
        time.sleep(0.2)
    raise AssertionError("Release QA condition timed out")


def visible_texts():
    return [
        value.strip()
        for node in ui().iter("node")
        for value in (node.get("text", ""), node.get("content-desc", ""))
        if value.strip()
    ]


def visible_text(fragment):
    return visible_node(fragment) is not None


def visible_node(fragment):
    needle = fragment.casefold()
    return next(
        (
            node
            for node in ui().iter("node")
            if any(
                needle in node.get(attribute, "").casefold()
                for attribute in ("text", "content-desc")
            )
        ),
        None,
    )


def live_home():
    values = [value.casefold() for value in visible_texts()]
    return (
        any(RELEASE_HOST_NAME.casefold() in value for value in values)
        and "terminal" in values
        and "add a host" not in values
    )


def check_release_webview_debugging():
    ro_debuggable = adb("shell", "getprop", "ro.debuggable").strip()
    assert ro_debuggable in ("0", "1"), "The emulator debug state is unavailable"
    pid = adb("shell", "pidof", PACKAGE).split()
    assert len(pid) == 1 and pid[0].isdigit(), "The signed release app must be running"
    socket = "webview_devtools_remote_" + pid[0]
    paths = []
    for line in adb("shell", "cat", "/proc/net/unix").splitlines():
        fields = line.split()
        if fields:
            paths.append(fields[-1])
    matched = next((path for path in (socket, "@" + socket) if path in paths), None)
    page_count = 0
    if matched:
        forward_port = "9236"
        forward = subprocess.run(
            [ADB, "-s", serial, "forward", f"tcp:{forward_port}", f"localabstract:{socket}"],
            capture_output=True,
            text=True,
        )
        if forward.returncode == 0:
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{forward_port}/json/list", timeout=3
                ) as response:
                    page_count = len(json.load(response))
            except Exception:
                page_count = -1
            finally:
                subprocess.run(
                    [ADB, "-s", serial, "forward", "--remove", f"tcp:{forward_port}"],
                    capture_output=True,
                    text=True,
                )
    print(
        "release WebView debug socket: "
        f"ro.debuggable={ro_debuggable} pid={pid[0]} expected={socket} "
        f"matched={matched or 'none'} pages={page_count}"
    )
    if ro_debuggable == "0":
        assert matched is None, "Signed release WebView debugging must remain disabled"
        return False
    print("release WebView debugging is provider-forced on this userdebug emulator")
    return True


def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def labelled(label):
    return next(
        (
            node
            for node in ui().iter("node")
            if node.get("text", "").casefold() == label.casefold()
            or node.get("content-desc", "").casefold() == label.casefold()
        ),
        None,
    )


def launch():
    adb(
        "shell",
        "am",
        "start",
        "-W",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LAUNCHER",
        "-f",
        "0x10200000",
        "-n",
        ACTIVITY,
    )


# A release must never silently fall back to the debug key or an unsigned package.
clean_env = {
    key: value
    for key, value in os.environ.items()
    if not key.startswith("OMARCHY_ANDROID_")
}
for extra, expected in [
    ({}, "storeFile"),
    ({"OMARCHY_ANDROID_KEY_ALIAS": "incomplete"}, "Set all four OMARCHY_ANDROID"),
]:
    result = subprocess.run(
        [
            str(ROOT / "android/gradlew"),
            "-p",
            str(ROOT / "android"),
            ":app:assembleRelease",
            "-PapplicationId=" + PACKAGE,
        ],
        env={**clean_env, **extra},
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0 and expected in result.stdout + result.stderr, (
        "Missing/partial signing configuration must fail clearly"
    )


with tempfile.TemporaryDirectory(prefix="android-release-qa-") as temp:
    env = dict(os.environ)
    password = secrets.token_hex(24)
    env.update(
        OMARCHY_ANDROID_KEYSTORE=str(pathlib.Path(temp) / "fixture.jks"),
        OMARCHY_ANDROID_STORE_PASSWORD=password,
        OMARCHY_ANDROID_KEY_ALIAS="fixture",
        OMARCHY_ANDROID_KEY_PASSWORD=password,
    )
    run(
        "keytool",
        "-genkeypair",
        "-keystore",
        env["OMARCHY_ANDROID_KEYSTORE"],
        "-storepass:env",
        "OMARCHY_ANDROID_STORE_PASSWORD",
        "-keypass:env",
        "OMARCHY_ANDROID_KEY_PASSWORD",
        "-alias",
        "fixture",
        "-keyalg",
        "RSA",
        "-keysize",
        "2048",
        "-validity",
        "2",
        "-dname",
        "CN=Temporary Android Release QA",
        env=env,
    )
    installed = False
    certificate = None
    webview_debug_forced = False
    try:
        for version in (401, 402):
            run(
                str(ROOT / "android/gradlew"),
                "-p",
                str(ROOT / "android"),
                ":app:assembleRelease",
                ":app:lintRelease",
                "-PapplicationId=" + PACKAGE,
                "-PversionCode=" + str(version),
                "-PversionName=release-qa",
                env=env,
                cwd=ROOT,
            )
            build_config = (
                ROOT
                / "android/app/build/generated/source/buildConfig/release/dev/omarchy/remote/BuildConfig.java"
            )
            assert re.search(
                r"public static final boolean DEBUG = false;", build_config.read_text()
            ), "Release BuildConfig.DEBUG must be false"
            apk = ROOT / "android/app/build/outputs/apk/release/app-release.apk"
            certs = run(
                str(SDK / "build-tools/36.0.0/apksigner"),
                "verify",
                "--print-certs",
                str(apk),
            )
            digest = re.search(r"Signer #1 certificate SHA-256 digest: (\w+)", certs)[1]
            assert certificate is None or certificate == digest
            certificate = digest
            manifest = run(
                str(SDK / "build-tools/36.0.0/aapt"),
                "dump",
                "xmltree",
                str(apk),
                "AndroidManifest.xml",
            )
            assert re.search(r"usesCleartextTraffic.*=\(type 0x12\)0x0", manifest), (
                "Release must reject cleartext traffic"
            )
            assert not re.search(r"debuggable.*=\(type 0x12\)0xffffffff", manifest), (
                "Release must not be debuggable"
            )
            adb("install", "-r", str(apk))
            installed = True
            assert "versionCode=" + str(version) in adb(
                "shell", "dumpsys", "package", PACKAGE
            )
            launch()
            if version == 401:
                button = until(lambda: labelled("Add a host"))
                if RELEASE_HOST_URL:
                    webview_debug_forced |= check_release_webview_debugging()
                tap(button)
                fields = until(
                    lambda: [
                        node
                        for node in ui().iter("node")
                        if node.get("class") == "android.widget.EditText"
                    ]
                )
                assert len(fields) == 2
                tap(fields[0])
                release_name = "ReleaseQAHTTPS" if RELEASE_HOST_URL else "ReleaseQA"
                release_url = RELEASE_HOST_URL or "https://release-qa.invalid"
                adb("shell", "input", "text", release_name)
                fields = [
                    node
                    for node in ui().iter("node")
                    if node.get("class") == "android.widget.EditText"
                ]
                tap(fields[1])
                adb("shell", "input", "text", release_url)
                tap(until(lambda: labelled("Save")))
                if RELEASE_HOST_URL:
                    tap(until(lambda: visible_node("ReleaseQAHTTPS")))
            if RELEASE_HOST_URL:
                until(live_home)
                webview_debug_forced |= check_release_webview_debugging()
            else:
                until(
                    lambda: any(
                        "ReleaseQA" in node.get("text", "") for node in ui().iter("node")
                    )
                )
            denied = subprocess.run(
                [ADB, "-s", serial, "shell", "run-as", PACKAGE, "pwd"],
                capture_output=True,
                text=True,
            )
            assert (
                denied.returncode != 0
                and "not debuggable" in denied.stderr + denied.stdout
            )
        screenshot = subprocess.check_output(
            [ADB, "-s", serial, "exec-out", "screencap", "-p"]
        )
        screenshot_name = (
            "release-live-home.png" if RELEASE_HOST_URL else "release-host-picker.png"
        )
        (ROOT / "artifacts/android" / screenshot_name).write_bytes(screenshot)
        if RELEASE_HOST_URL:
            debug_result = (
                "userdebug WebView policy recorded"
                if webview_debug_forced
                else "WebView debugging disabled"
            )
            print(
                "PASS: signed release builds, real HTTPS host connection, visible live Home, "
                + debug_result
                + ", stable certificate and in-place update"
            )
        else:
            print(
                "PASS: signed release builds, HTTPS-only/non-debuggable manifest, native launch, stable certificate and in-place update preserving saved hosts"
            )
    finally:
        if installed:
            adb("uninstall", PACKAGE)
        adb("shell", "rm", "-f", "/sdcard/release-qa.xml")
        # The regular emulator app and its data are untouched.
        adb(
            "shell",
            "am",
            "start",
            "-W",
            "-a",
            "android.intent.action.MAIN",
            "-c",
            "android.intent.category.LAUNCHER",
            "-f",
            "0x10200000",
            "-n",
            "dev.omarchy.remote/.ShellActivity",
        )
