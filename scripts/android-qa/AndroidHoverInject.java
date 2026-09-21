import android.content.Context;
import android.hardware.input.InputManager;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.MotionEvent;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

/** QA-only native pointer injection. Run through app_process on an emulator shell. */
public final class AndroidHoverInject {
  private static final int INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH = 2;

  private AndroidHoverInject() {}

  public static void main(String[] args) throws Exception {
    if (args.length < 3) {
      throw new IllegalArgumentException("usage: MOVE <x> <y> [mouse|stylus] [buttons]");
    }
    int action = action(args[0]);
    float x = Float.parseFloat(args[1]);
    float y = Float.parseFloat(args[2]);
    String toolName = args.length > 3 ? args[3] : "mouse";
    int buttons = args.length > 4 ? Integer.parseInt(args[4]) : 0;
    int source = source(toolName);
    int tool = tool(toolName);
    long now = android.os.SystemClock.uptimeMillis();

    MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
    properties.id = 0;
    properties.toolType = tool;
    MotionEvent.PointerCoords coordinates = new MotionEvent.PointerCoords();
    coordinates.x = x;
    coordinates.y = y;
    coordinates.pressure = 1;
    coordinates.size = 1;
    MotionEvent event =
        MotionEvent.obtain(
            now,
            now,
            action,
            1,
            new MotionEvent.PointerProperties[] {properties},
            new MotionEvent.PointerCoords[] {coordinates},
            0,
            buttons,
            1,
            1,
            0,
            0,
            source,
            0);
    try {
      Constructor<?> constructor = InputManager.class.getDeclaredConstructor(Context.class);
      constructor.setAccessible(true);
      Object inputManager = constructor.newInstance((Object) null);
      Method inject =
          InputManager.class.getDeclaredMethod("injectInputEvent", InputEvent.class, int.class);
      inject.setAccessible(true);
      boolean accepted =
          (Boolean) inject.invoke(inputManager, event, INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH);
      if (!accepted) {
        throw new IllegalStateException("InputManager rejected the event");
      }
    } finally {
      event.recycle();
    }
  }

  private static int action(String value) {
    if (!"MOVE".equalsIgnoreCase(value)) {
      throw new IllegalArgumentException("Only MOVE is supported for native hover injection");
    }
    return MotionEvent.ACTION_HOVER_MOVE;
  }

  private static int source(String value) {
    return "stylus".equalsIgnoreCase(value) ? InputDevice.SOURCE_STYLUS : InputDevice.SOURCE_MOUSE;
  }

  private static int tool(String value) {
    return "stylus".equalsIgnoreCase(value)
        ? MotionEvent.TOOL_TYPE_STYLUS
        : MotionEvent.TOOL_TYPE_MOUSE;
  }
}
