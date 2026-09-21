package dev.omarchy.remote;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.json.JSONObject;

/** Downloads only content-addressed updates for this package from the selected host. */
final class DeviceBuilds {
  private final Activity activity;
  private boolean busy;

  DeviceBuilds(Activity activity) {
    this.activity = activity;
  }

  void install(String host, String hash, BooleanSupplier current, Consumer<JSONObject> reply) {
    if (busy) throw new IllegalStateException("An update is already being prepared");
    if (!hash.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid build identity");
    busy = true;
    new Thread(
            () -> {
              File apk = null;
              try {
                File folder = new File(activity.getCacheDir(), "updates");
                if (!folder.isDirectory() && !folder.mkdirs())
                  throw new Exception("Cannot prepare update folder");
                apk = File.createTempFile("download-", ".apk", folder);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                HttpURLConnection connection =
                    (HttpURLConnection)
                        new URL(host + "/builds/" + hash + "/app.apk").openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(20000);
                try {
                  if (connection.getResponseCode() != 200)
                    throw new Exception("Build download unavailable");
                  try (var input = connection.getInputStream();
                      var output = new FileOutputStream(apk)) {
                    byte[] buffer = new byte[65536];
                    long total = 0;
                    long deadline = android.os.SystemClock.elapsedRealtime() + 120000;
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                      total += count;
                      if (total > 134217728 || android.os.SystemClock.elapsedRealtime() > deadline)
                        throw new Exception("Build download exceeded its size or time limit");
                      digest.update(buffer, 0, count);
                      output.write(buffer, 0, count);
                    }
                  }
                } finally {
                  connection.disconnect();
                }
                StringBuilder actual = new StringBuilder();
                for (byte value : digest.digest())
                  actual.append(String.format("%02x", value & 255));
                if (!hash.contentEquals(actual)) throw new Exception("Build checksum mismatch");
                PackageManager manager = activity.getPackageManager();
                PackageInfo candidate =
                    manager.getPackageArchiveInfo(
                        apk.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
                PackageInfo installed = manager.getPackageInfo(activity.getPackageName(), 0);
                if (candidate == null || !activity.getPackageName().equals(candidate.packageName))
                  throw new Exception("This build is for a different app");
                if (candidate.applicationInfo == null
                    || candidate.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT)
                  throw new Exception("This build requires a newer Android version");
                if (candidate.getLongVersionCode() < installed.getLongVersionCode())
                  throw new Exception("This build is older than the installed app");
                if (candidate.signingInfo == null
                    || candidate.signingInfo.getApkContentsSigners().length == 0)
                  throw new Exception("Build signature unavailable");
                for (var signature : candidate.signingInfo.getApkContentsSigners()) {
                  if (!manager.hasSigningCertificate(
                      activity.getPackageName(),
                      signature.toByteArray(),
                      PackageManager.CERT_INPUT_RAW_X509))
                    throw new Exception("Build signing key does not match the installed app");
                }
                File ready = new File(folder, hash + ".apk");
                java.nio.file.Files.move(
                    apk.toPath(),
                    ready.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                activity.runOnUiThread(
                    () -> {
                      busy = false;
                      try {
                        if (activity.isDestroyed()
                            || activity.isFinishing()
                            || !current.getAsBoolean()) {
                          ready.delete();
                          throw new Exception(
                              "Return to the connected host and request installation again");
                        }
                        if (!activity.getPackageManager().canRequestPackageInstalls()) {
                          activity.startActivity(
                              new Intent(
                                  Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                  Uri.parse("package:" + activity.getPackageName())));
                          reply.accept(new JSONObject().put("permissionRequired", true));
                          return;
                        }
                        Uri uri =
                            FileProvider.getUriForFile(
                                activity, activity.getPackageName() + ".updates", ready);
                        Intent install =
                            new Intent(Intent.ACTION_VIEW)
                                .setDataAndType(uri, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        activity.startActivity(install);
                        reply.accept(new JSONObject().put("opened", true));
                      } catch (Exception error) {
                        reply.accept(error(error));
                      }
                    });
              } catch (Exception error) {
                if (apk != null) apk.delete();
                activity.runOnUiThread(
                    () -> {
                      busy = false;
                      reply.accept(error(error));
                    });
              }
            },
            "download-app-update")
        .start();
  }

  private JSONObject error(Exception error) {
    JSONObject result = new JSONObject();
    try {
      result.put(
          "error", error.getMessage() == null ? "Could not prepare update" : error.getMessage());
    } catch (Exception ignored) {
      // Constant key and string value cannot fail JSON encoding.
    }
    return result;
  }
}
