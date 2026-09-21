package dev.omarchy.qa.share;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.widget.TextView;
import java.io.*;
import org.json.JSONObject;

/** Isolated receiver for emulator QA. No network access or storage permissions. */
public final class ReceiveActivity extends Activity {
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    TextView status = new TextView(this);
    setContentView(status);
    try {
      Uri uri = getIntent().getParcelableExtra(Intent.EXTRA_STREAM);
      if (uri == null) throw new IOException("No shared URI");
      String name = "";
      try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
        if (cursor != null && cursor.moveToFirst())
          name = cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME));
      }
      try (InputStream input = getContentResolver().openInputStream(uri);
          OutputStream output = openFileOutput("received.bin", MODE_PRIVATE)) {
        if (input == null) throw new IOException("No readable stream");
        byte[] buffer = new byte[65536];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
      }
      boolean writeDenied = false;
      try (OutputStream ignored = getContentResolver().openOutputStream(uri, "wa")) {
        // No bytes are written even if the permission check unexpectedly fails.
      } catch (SecurityException expected) {
        writeDenied = true;
      }
      JSONObject report =
          new JSONObject()
              .put("name", name)
              .put("type", getIntent().getType())
              .put("scheme", uri.getScheme())
              .put("writeDenied", writeDenied);
      try (OutputStream out = openFileOutput("report.json", MODE_PRIVATE)) {
        out.write(report.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
      }
      status.setText("Received " + name);
    } catch (Exception error) {
      status.setText("Failed: " + error);
    }
  }
}
