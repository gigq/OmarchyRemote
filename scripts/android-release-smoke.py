"""Build and update an isolated release identity with a temporary signing key."""

import os
import pathlib
import re
import secrets
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
SDK = pathlib.Path(os.environ.get("ANDROID_SDK_ROOT", "/opt/android-sdk"))
ADB = str(SDK / "platform-tools/adb")
PACKAGE = "dev.omarchy.remote.releaseqa"
ACTIVITY = PACKAGE + "/dev.omarchy.remote.ShellActivity"


def run(*args, **kwargs):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, **kwargs
    ).stdout.strip()


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
                adb("shell", "input", "text", "ReleaseQA")
                fields = [
                    node
                    for node in ui().iter("node")
                    if node.get("class") == "android.widget.EditText"
                ]
                tap(fields[1])
                adb("shell", "input", "text", "https://release-qa.invalid")
                tap(until(lambda: labelled("Save")))
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
        (ROOT / "artifacts/android/release-host-picker.png").write_bytes(screenshot)
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
