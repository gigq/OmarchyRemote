# Android release signing

Debug APKs use Android's development key. For a durable release identity, create a private keystore once and reuse it for every update. Android requires the same signing identity to update an installed app; a release key cannot replace an existing debug-signed installation under the same package name. Keep the keystore and its passwords backed up outside this repository. See [Android's app-signing documentation](https://developer.android.com/studio/publish/app-signing).

Create the key interactively, choosing an absolute location outside the checkout:

```sh
keytool -genkeypair -keystore /absolute/private/path/omarchy-remote.jks \
  -alias omarchy-remote -keyalg RSA -keysize 3072 -validity 10000
```

Supply these environment variables from your private environment or CI secret store:

| Variable                         | Value                                                |
| -------------------------------- | ---------------------------------------------------- |
| `OMARCHY_ANDROID_KEYSTORE`       | Absolute path to the keystore                        |
| `OMARCHY_ANDROID_STORE_PASSWORD` | Keystore password                                    |
| `OMARCHY_ANDROID_KEY_ALIAS`      | Alias selected when creating the key                 |
| `OMARCHY_ANDROID_KEY_PASSWORD`   | Private-key password (usually the keystore password) |

Build with the package identity you intend to keep, and increase the version code for updates:

```sh
android/gradlew -p android :app:assembleRelease :app:lintRelease \
  -PapplicationId=your.package.name -PversionCode=3 -PversionName=0.3.1
```

The APK is `android/app/build/outputs/apk/release/app-release.apk`. Release builds require a signing configuration; partial signing configuration fails with a setup error. They disable WebView debugging, reject cleartext HTTP, and start at the host picker. `remoteUrl` seeds a host only in debug builds. Add your private HTTPS host in the release app.

Verify the resulting signature with your installed Android SDK build-tools:

```sh
apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk
```

The existing Builds publisher accepts the signed APK. Keep the package name and signing key unchanged when publishing an update. A new signing identity needs a separate installation or removal of the old app; do not uninstall your daily app merely to test signing.

`python scripts/android-release-smoke.py` tests the workflow in an emulator using a temporary key and the separate `dev.omarchy.remote.releaseqa` identity. It builds two release versions, verifies their signatures and manifests, installs/launches them, and checks that the second installation preserves a saved host. It also verifies `run-as` is denied for the non-debuggable release. The fixture never connects to its example host and leaves the regular app's installation/data intact. It removes the QA installation and private key afterward. Its release APK is a disposable test artifact, not a distributable production identity; rebuild with your durable key before publishing.
