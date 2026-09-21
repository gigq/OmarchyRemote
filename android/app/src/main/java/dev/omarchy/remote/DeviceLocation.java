package dev.omarchy.remote;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BiConsumer;

/** One foreground weather lookup, with bounded lifetime and no background tracking. */
final class DeviceLocation {
  static final int PERMISSION_REQUEST = 21;
  private final Activity activity;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final List<CancellationSignal> signals = new ArrayList<>();
  private BiConsumer<Location, String> pending;
  private int generation;
  private final Runnable timeout = () -> finish(null, "Location timed out. Try again outdoors.");

  DeviceLocation(Activity activity) {
    this.activity = activity;
  }

  void request(boolean ask, BiConsumer<Location, String> callback) {
    if (pending != null) {
      callback.accept(null, "A location request is already in progress.");
      return;
    }
    pending = callback;
    if (!granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
      if (!ask) {
        finish(null, "Allow location access using the weather compass button.");
        return;
      }
      activity.requestPermissions(
          new String[] {
            Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION
          },
          PERMISSION_REQUEST);
      return;
    }
    locate();
  }

  void permissionResult() {
    if (pending == null) return;
    if (!granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
      finish(null, "Location permission was denied. You can enter a city instead.");
      return;
    }
    locate();
  }

  private boolean granted(String permission) {
    return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
  }

  private void locate() {
    LocationManager manager = activity.getSystemService(LocationManager.class);
    if (!manager.isLocationEnabled()) {
      finish(null, "Turn on Android location services or enter a city.");
      return;
    }
    List<String> providers = new ArrayList<>();
    if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
      providers.add(LocationManager.NETWORK_PROVIDER);
    if (granted(Manifest.permission.ACCESS_FINE_LOCATION)
        && manager.isProviderEnabled(LocationManager.GPS_PROVIDER))
      providers.add(LocationManager.GPS_PROVIDER);
    if (providers.isEmpty()) {
      finish(null, "No location provider is available. Enter a city instead.");
      return;
    }
    int token = ++generation;
    int[] remaining = {providers.size()};
    handler.postDelayed(timeout, 20000);
    for (String provider : providers) {
      CancellationSignal signal = new CancellationSignal();
      signals.add(signal);
      try {
        manager.getCurrentLocation(
            provider,
            signal,
            activity.getMainExecutor(),
            location -> {
              if (token != generation || pending == null) return;
              if (location != null) finish(location, null);
              else if (--remaining[0] == 0)
                finish(null, "Location unavailable. Try again or enter a city.");
            });
      } catch (SecurityException | IllegalArgumentException error) {
        if (--remaining[0] == 0)
          finish(null, "Location unavailable. Check Android location permissions.");
      }
    }
  }

  void cancel() {
    finish(null, "Location request cancelled.");
  }

  private void finish(Location location, String error) {
    generation++;
    handler.removeCallbacks(timeout);
    for (CancellationSignal signal : signals) signal.cancel();
    signals.clear();
    BiConsumer<Location, String> callback = pending;
    pending = null;
    if (callback != null) callback.accept(location, error);
  }
}
