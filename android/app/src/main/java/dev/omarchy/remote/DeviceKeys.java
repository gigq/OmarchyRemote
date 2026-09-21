package dev.omarchy.remote;

import android.view.KeyEvent;
import org.json.JSONArray;
import org.json.JSONObject;

/** Matches the shared, per-device action registry; it owns no duplicate shortcut table. */
final class DeviceKeys {
  private JSONArray commands = new JSONArray();

  void register(JSONArray next) {
    if (next == null || next.length() > 256) return;
    for (int i = 0; i < next.length(); i++) {
      JSONObject row = next.optJSONObject(i);
      if (row == null
          || row.optString("code").length() > 32
          || row.optString("label").length() > 160) return;
    }
    commands = next;
  }

  JSONObject match(KeyEvent event, boolean editing) {
    String code = code(event.getKeyCode());
    if (code == null) return null;
    for (int i = 0; i < commands.length(); i++) {
      JSONObject row = commands.optJSONObject(i);
      if (!code.equals(row.optString("code")) || row.optBoolean("shift") != event.isShiftPressed())
        continue;
      if (editing && row.optBoolean("editing")) continue;
      boolean exact =
          row.optBoolean("meta") == event.isMetaPressed()
              && row.optBoolean("ctrl") == event.isCtrlPressed()
              && row.optBoolean("alt") == event.isAltPressed();
      boolean alias =
          row.optBoolean("meta")
              && !row.optBoolean("ctrl")
              && !row.optBoolean("alt")
              && !event.isMetaPressed()
              && event.isCtrlPressed()
              && event.isAltPressed();
      if (exact || alias) return row;
    }
    return null;
  }

  private static String code(int key) {
    if (key >= KeyEvent.KEYCODE_A && key <= KeyEvent.KEYCODE_Z)
      return "Key" + (char) ('A' + key - KeyEvent.KEYCODE_A);
    if (key >= KeyEvent.KEYCODE_0 && key <= KeyEvent.KEYCODE_9)
      return "Digit" + (key - KeyEvent.KEYCODE_0);
    if (key >= KeyEvent.KEYCODE_F1 && key <= KeyEvent.KEYCODE_F12)
      return "F" + (key - KeyEvent.KEYCODE_F1 + 1);
    return switch (key) {
      case KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft";
      case KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight";
      case KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp";
      case KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown";
      case KeyEvent.KEYCODE_PAGE_UP -> "PageUp";
      case KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown";
      case KeyEvent.KEYCODE_ESCAPE -> "Escape";
      case KeyEvent.KEYCODE_TAB -> "Tab";
      case KeyEvent.KEYCODE_ENTER -> "Enter";
      case KeyEvent.KEYCODE_NUMPAD_ENTER -> "NumpadEnter";
      case KeyEvent.KEYCODE_DEL -> "Backspace";
      case KeyEvent.KEYCODE_SPACE -> "Space";
      case KeyEvent.KEYCODE_LEFT_BRACKET -> "BracketLeft";
      case KeyEvent.KEYCODE_RIGHT_BRACKET -> "BracketRight";
      case KeyEvent.KEYCODE_SLASH -> "Slash";
      case KeyEvent.KEYCODE_BACKSLASH -> "Backslash";
      case KeyEvent.KEYCODE_COMMA -> "Comma";
      case KeyEvent.KEYCODE_PERIOD -> "Period";
      case KeyEvent.KEYCODE_SEMICOLON -> "Semicolon";
      case KeyEvent.KEYCODE_APOSTROPHE -> "Quote";
      case KeyEvent.KEYCODE_GRAVE -> "Backquote";
      case KeyEvent.KEYCODE_EQUALS -> "Equal";
      case KeyEvent.KEYCODE_MINUS -> "Minus";
      case KeyEvent.KEYCODE_NUMPAD_ADD -> "NumpadAdd";
      case KeyEvent.KEYCODE_NUMPAD_SUBTRACT -> "NumpadSubtract";
      default -> null;
    };
  }
}
