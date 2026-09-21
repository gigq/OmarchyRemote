package dev.omarchy.remote;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import java.io.*;
import java.util.UUID;
import java.util.function.Consumer;
import org.json.JSONObject;

/** Stages bounded chunks from the trusted shell, then saves to a user-selected document. */
final class DeviceFiles {
  static final int SAVE_REQUEST = 22;
  private final Activity activity;
  private File staged;
  private String token;
  private String name;
  private String mime;
  private long expected;
  private Consumer<JSONObject> completion;
  private boolean copying;

  DeviceFiles(Activity activity) {
    this.activity = activity;
    File[] abandoned =
        activity.getCacheDir().listFiles((dir, filename) -> filename.startsWith("shell-save-"));
    if (abandoned != null) for (File file : abandoned) file.delete();
  }

  void dispatch(JSONObject body, Consumer<JSONObject> reply) throws Exception {
    String action = body.optString("action");
    if (action.equals("begin")) {
      if (staged != null) throw new IllegalStateException("A file save is already in progress.");
      long size = body.optLong("size", -1);
      if (size < 0 || size > activity.getCacheDir().getUsableSpace())
        throw new IllegalArgumentException("Not enough device space to save this file.");
      name = body.optString("name", "download").replaceAll("[\\\\/\\p{Cntrl}]", "_");
      if (name.isBlank()) name = "download";
      mime = body.optString("type", "application/octet-stream");
      if (!mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")) mime = "application/octet-stream";
      staged = File.createTempFile("shell-save-", ".tmp", activity.getCacheDir());
      expected = size;
      token = UUID.randomUUID().toString();
      reply.accept(ShellActivity.object("token", token));
      return;
    }
    if (staged == null || !body.optString("token").equals(token))
      throw new IllegalArgumentException("This file save is no longer active.");
    if (copying) throw new IllegalStateException("The file is being saved.");
    switch (action) {
      case "append":
        if (completion != null) throw new IllegalStateException("The file is already complete.");
        String encoded = body.optString("data");
        if (encoded.length() > 262144)
          throw new IllegalArgumentException("File chunk is too large.");
        byte[] chunk = Base64.decode(encoded, Base64.NO_WRAP);
        if (body.optLong("offset", -1) != staged.length()
            || staged.length() + chunk.length > expected)
          throw new IllegalArgumentException("File transfer is out of order.");
        try (OutputStream out = new FileOutputStream(staged, true)) {
          out.write(chunk);
        }
        reply.accept(ShellActivity.object("ok", true));
        break;
      case "save":
        if (completion != null) throw new IllegalStateException("A save dialog is already open.");
        if (staged.length() != expected)
          throw new IllegalArgumentException("File transfer is incomplete.");
        completion = reply;
        try {
          activity.startActivityForResult(
              new Intent(Intent.ACTION_CREATE_DOCUMENT)
                  .addCategory(Intent.CATEGORY_OPENABLE)
                  .setType(mime)
                  .putExtra(Intent.EXTRA_TITLE, name),
              SAVE_REQUEST);
        } catch (Exception error) {
          finish(ShellActivity.object("error", "No Android file picker is available."));
        }
        break;
      case "cancel":
        cancel();
        reply.accept(ShellActivity.object("ok", true));
        break;
      default:
        throw new IllegalArgumentException("Unknown file action.");
    }
  }

  void result(int result, Intent data) {
    if (completion == null || staged == null) return;
    Uri destination = data == null ? null : data.getData();
    if (result != Activity.RESULT_OK || destination == null) {
      finish(ShellActivity.object("cancelled", true));
      return;
    }
    copying = true;
    File source = staged;
    new Thread(
            () -> {
              JSONObject response;
              try (InputStream input = new FileInputStream(source);
                  OutputStream output =
                      activity.getContentResolver().openOutputStream(destination, "wt")) {
                if (output == null) throw new IOException("Destination is unavailable");
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                response = ShellActivity.object("saved", true);
              } catch (Exception error) {
                response =
                    ShellActivity.object("error", "Could not save the file: " + error.getMessage());
              }
              JSONObject completed = response;
              activity.runOnUiThread(() -> finish(completed));
            },
            "document-save")
        .start();
  }

  void cancel() {
    // An already authorized document write finishes independently of the shell's lifecycle.
    if (!copying) finish(ShellActivity.object("cancelled", true));
    else completion = null;
  }

  private void finish(JSONObject response) {
    Consumer<JSONObject> callback = completion;
    completion = null;
    if (staged != null) staged.delete();
    staged = null;
    token = null;
    copying = false;
    if (callback != null) callback.accept(response);
  }
}
