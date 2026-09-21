package dev.omarchy.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.*;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.view.inputmethod.InputMethodManager;
import android.webkit.*;
import android.widget.*;
import androidx.webkit.*;
import java.io.*;
import java.util.*;
import org.json.*;

/** Android host for the shared shell. External pages never receive the shell bridge. */
public final class ShellActivity extends Activity {
  private static final String ASSET = "https://appassets.androidplatform.net";
  private final Map<String, Page> pages = new LinkedHashMap<>();
  private FrameLayout root;
  private DeviceLocation deviceLocation;
  private DeviceFiles deviceFiles;
  private final DeviceKeys deviceKeys = new DeviceKeys();
  private final Set<Integer> consumedKeys = new HashSet<>();
  private boolean shellEditing;
  private boolean awaitingLaunchFocus;
  private boolean replayingLaunchKeys;
  private int launchRequestedToken;
  private int launchReadyToken;
  private int launchGeneration;
  private final ArrayList<KeyEvent> launchKeys = new ArrayList<>();
  private final Runnable abandonLaunchKeys = () -> cancelLaunchFocus();
  private volatile boolean bundled;
  private boolean foreground;
  private boolean probing;
  private int retrySeconds = 3;
  private final Runnable reconnect = this::probeHost;
  private WebView shell;
  private android.content.SharedPreferences prefs;
  private JSONObject directory;
  private String selected = "";
  private ValueCallback<Uri[]> fileCallback;
  private DeviceBuilds deviceBuilds;
  private WebViewAssetLoader assets;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final BroadcastReceiver battery =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          int level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
          int scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
          int state = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
          publishBattery(level < 0 ? -1 : Math.round(100f * level / scale), state);
        }
      };

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    deviceLocation = new DeviceLocation(this);
    deviceFiles = new DeviceFiles(this);
    deviceBuilds = new DeviceBuilds(this);
    prefs = getSharedPreferences("shell", MODE_PRIVATE);
    directory = json(prefs.getString("hosts", "{\"hosts\":[]}"));
    selected = directory.optString("selected", "");
    if (selected.equals("null")) selected = "";
    if (BuildConfig.DEBUG && !BuildConfig.REMOTE_URL.isEmpty() && selected.isEmpty()) {
      saveHost("Development host", BuildConfig.REMOTE_URL);
      selected = normalize(BuildConfig.REMOTE_URL);
      put(directory, "selected", selected);
      persistHosts();
    }
    root = new FrameLayout(this);
    root.setBackgroundColor(Color.rgb(25, 23, 36));
    setContentView(root);
    assets =
        new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
    getWindow()
        .getDecorView()
        .setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    root.setOnApplyWindowInsetsListener(
        (view, insets) -> {
          int inset = insets.getInsets(WindowInsets.Type.ime()).bottom;
          float density = getResources().getDisplayMetrics().density;
          evaluate(
              "window.__HYPRLAND_KEYBOARD__={inset:"
                  + inset / density
                  + ",height:"
                  + root.getHeight() / density
                  + "};window.dispatchEvent(new Event('hyprland-keyboard'));",
              null);
          return insets;
        });
    registerReceiver(battery, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    loadShell(directory.optBoolean("disconnected") || selected.isEmpty());
  }

  private String origin(String raw) {
    Uri uri = Uri.parse(raw);
    return uri.getScheme() + "://" + uri.getEncodedAuthority();
  }

  private String normalize(String raw) {
    Uri uri = Uri.parse(raw.contains("://") ? raw : "https://" + raw);
    boolean local =
        BuildConfig.DEBUG
            && "http".equals(uri.getScheme())
            && Arrays.asList("127.0.0.1", "localhost", "10.0.2.2").contains(uri.getHost());
    if ((!"https".equals(uri.getScheme()) && !local)
        || uri.getHost() == null
        || uri.getUserInfo() != null
        || uri.getQuery() != null
        || uri.getFragment() != null)
      throw new IllegalArgumentException("Use the host’s HTTPS address");
    if (!Arrays.asList("", "/", "/native", "/native/").contains(uri.getPath()))
      throw new IllegalArgumentException("Use the host address without a custom path");
    return origin(uri.toString()) + "/native/";
  }

  private void saveHost(String name, String raw) {
    String url = normalize(raw);
    JSONArray hosts = directory.optJSONArray("hosts");
    if (hosts == null) hosts = new JSONArray();
    JSONArray next = new JSONArray();
    for (int i = 0; i < hosts.length(); i++)
      if (!hosts.optJSONObject(i).optString("id").equals(url)) next.put(hosts.optJSONObject(i));
    if (next.length() >= 10) throw new IllegalArgumentException("You can save up to 10 hosts");
    next.put(
        object("id", url, "url", url, "name", name.isBlank() ? Uri.parse(url).getHost() : name));
    put(directory, "hosts", next);
    persistHosts();
  }

  private void persistHosts() {
    prefs.edit().putString("hosts", directory.toString()).apply();
  }

  private WebView makeWebView() {
    WebView web =
        new WebView(this) {
          @Override
          public boolean onKeyPreIme(int key, KeyEvent event) {
            boolean editing =
                shellEditing || pages.values().stream().anyMatch(page -> page.web.hasFocus());
            if (consumedKeys.contains(key)
                || (event.getAction() == KeyEvent.ACTION_DOWN
                    && deviceKeys.match(event, editing) != null)) {
              return ShellActivity.this.dispatchKeyEvent(event);
            }
            if (event.getUnicodeChar() >= 32 && bufferTransitionKey(event)) return true;
            WindowInsets insets = root.getRootWindowInsets();
            if (key == KeyEvent.KEYCODE_BACK
                && insets != null
                && !insets.isVisible(WindowInsets.Type.ime())) {
              if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) onBackPressed();
              return true;
            }
            return super.onKeyPreIme(key, event);
          }
        };
    web.setBackgroundColor(Color.rgb(25, 23, 36));
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(true);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(true);
    web.getSettings().setMediaPlaybackRequiresUserGesture(true);
    web.getSettings().setSupportMultipleWindows(true);
    web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES);
    web.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onShowFileChooser(
              WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
              startActivityForResult(params.createIntent(), 10);
            } catch (ActivityNotFoundException error) {
              fileCallback.onReceiveValue(null);
              fileCallback = null;
            }
            return true;
          }

          @Override
          public boolean onCreateWindow(
              WebView view, boolean dialog, boolean userGesture, Message result) {
            if (!userGesture) return false;
            WebView temporary = new WebView(ShellActivity.this);
            temporary.setWebViewClient(
                new WebViewClient() {
                  @Override
                  public boolean shouldOverrideUrlLoading(
                      WebView ignored, WebResourceRequest request) {
                    if (http(request.getUrl())) view.loadUrl(request.getUrl().toString());
                    temporary.destroy();
                    return true;
                  }
                });
            ((WebView.WebViewTransport) result.obj).setWebView(temporary);
            result.sendToTarget();
            return true;
          }
        });
    return web;
  }

  private boolean http(Uri url) {
    return "https".equals(url.getScheme()) || "http".equals(url.getScheme());
  }

  private String assetText(String file) {
    try (InputStream input = getAssets().open(file)) {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int count;
      while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
      return output.toString(java.nio.charset.StandardCharsets.UTF_8.name());
    } catch (IOException error) {
      throw new IllegalStateException(error);
    }
  }

  private void loadShell(boolean picker) {
    handler.removeCallbacks(reconnect);
    cancelLaunchFocus();
    bundled = false;
    retrySeconds = 3;
    deviceKeys.register(new JSONArray());
    consumedKeys.clear();
    shellEditing = false;
    deviceLocation.cancel();
    deviceFiles.cancel();
    for (Page page : pages.values()) {
      page.closeFind();
      root.removeView(page.web);
      page.web.destroy();
    }
    pages.clear();
    if (shell != null) {
      root.removeView(shell);
      shell.destroy();
    }
    shell = makeWebView();
    root.addView(shell, 0, new FrameLayout.LayoutParams(-1, -1));
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    Set<String> allowed = new HashSet<>(Set.of(ASSET));
    if (!selected.isEmpty()) allowed.add(origin(selected));
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      new AlertDialog.Builder(this)
          .setMessage("Update Android System WebView to run Omarchy Remote.")
          .setPositiveButton("OK", null)
          .show();
      return;
    }
    String id = prefs.getString("device-id", "");
    if (id.isEmpty()) {
      id = UUID.randomUUID().toString();
      prefs.edit().putString("device-id", id).apply();
    }
    JSONObject device =
        object(
            "id",
            id,
            "name",
            Build.MODEL,
            "scope",
            selected,
            "hosts",
            directory,
            "snapshot",
            json(prefs.getString("state:" + selected, "{}")));
    String source = "window.__OMARCHY_DEVICE__=" + device + ";" + assetText("android-bridge.js");
    WebViewCompat.addDocumentStartJavaScript(shell, source, allowed);
    WebViewCompat.addWebMessageListener(
        shell,
        "AndroidShell",
        allowed,
        (web, message, sourceOrigin, mainFrame, reply) -> {
          if (!mainFrame
              || (!sourceOrigin.toString().equals(ASSET)
                  && !sourceOrigin.toString().equals(selected.isEmpty() ? "" : origin(selected))))
            return;
          JSONObject request = json(message.getData());
          int serial = request.optInt("id");
          try {
            dispatch(
                request.optString("channel"),
                request.opt("body"),
                value -> reply.postMessage(object("id", serial, "value", value).toString()));
          } catch (Exception error) {
            reply.postMessage(
                object(
                        "id",
                        serial,
                        "error",
                        error.getMessage() == null ? "Native request failed" : error.getMessage())
                    .toString());
          }
        });
    WebViewAssetLoader.AssetsPathHandler bundledAssets =
        new WebViewAssetLoader.AssetsPathHandler(this);
    shell.setWebViewClient(
        new WebViewClient() {
          @Override
          public void onPageStarted(WebView view, String url, Bitmap favicon) {
            deviceFiles.cancel();
            deviceLocation.cancel();
          }

          @Override
          public WebResourceResponse shouldInterceptRequest(
              WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (bundled
                && !selected.isEmpty()
                && origin(url.toString()).equals(origin(selected))
                && url.getPath() != null
                && url.getPath().startsWith("/native/")) {
              String path = url.getPath().substring("/native/".length());
              return bundledAssets.handle("Web/" + (path.isEmpty() ? "index.html" : path));
            }
            return assets.shouldInterceptRequest(url);
          }

          @Override
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String target = origin(request.getUrl().toString());
            if (request.isForMainFrame() && !allowed.contains(target)) {
              if (request.hasGesture() && http(request.getUrl()))
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
              return true;
            }
            return false;
          }

          @Override
          public void onPageFinished(WebView view, String url) {
            if (view != shell) return;
            evaluate("window.__OMARCHY_BUNDLED__=" + bundled + ";", null);
            publishHardwareKeyboard();
            Intent state = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (state != null) battery.onReceive(ShellActivity.this, state);
          }

          @Override
          public void onReceivedError(
              WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) fallback(view);
          }

          @Override
          public void onReceivedHttpError(
              WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame()) fallback(view);
          }

          @Override
          public void onReceivedSslError(
              WebView view, SslErrorHandler ssl, android.net.http.SslError error) {
            ssl.cancel();
            fallback(view);
          }
        });
    shell.loadUrl(picker ? ASSET + "/assets/Web/hosts.html" : selected);
  }

  private void fallback(WebView view) {
    if (view != shell || bundled || selected.isEmpty() || directory.optBoolean("disconnected"))
      return;
    bundled = true;
    view.loadUrl(selected);
    handler.removeCallbacks(reconnect);
    if (foreground) handler.postDelayed(reconnect, retrySeconds * 1000L);
  }

  private void probeHost() {
    if (!foreground || !bundled || probing || selected.isEmpty()) return;
    probing = true;
    String host = selected;
    WebView target = shell;
    new Thread(
            () -> {
              boolean ready = false;
              java.net.HttpURLConnection connection = null;
              try {
                connection = (java.net.HttpURLConnection) new java.net.URL(host).openConnection();
                connection.setRequestMethod("HEAD");
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(3000);
                connection.setInstanceFollowRedirects(false);
                ready =
                    connection.getResponseCode() == 200
                        && String.valueOf(connection.getContentType()).startsWith("text/html");
              } catch (IOException ignored) {
                // Stay in the usable bundled shell until this exact host becomes reachable.
              } finally {
                if (connection != null) connection.disconnect();
              }
              boolean available = ready;
              handler.post(
                  () -> {
                    probing = false;
                    if (!foreground || !bundled) return;
                    if (target == shell && host.equals(selected) && available) {
                      loadShell(false);
                    } else {
                      retrySeconds = Math.min(30, retrySeconds * 2);
                      handler.postDelayed(reconnect, retrySeconds * 1000L);
                    }
                  });
            },
            "host-reconnect")
        .start();
  }

  @Override
  protected void onResume() {
    super.onResume();
    foreground = true;
    if (shell != null) {
      shell.onResume();
      evaluate(
          "window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));",
          null);
    }
    for (Page page : pages.values()) page.web.onResume();
    handler.removeCallbacks(reconnect);
    if (bundled) handler.post(reconnect);
  }

  @Override
  protected void onPause() {
    cancelLaunchFocus();
    foreground = false;
    handler.removeCallbacks(reconnect);
    if (shell != null) {
      evaluate("window.dispatchEvent(new Event('pagehide'));", null);
      shell.onPause();
    }
    for (Page page : pages.values()) page.web.onPause();
    super.onPause();
  }

  private interface Reply {
    void send(Object value);
  }

  private void dispatch(String channel, Object raw, Reply reply) throws Exception {
    JSONObject body = raw instanceof JSONObject ? (JSONObject) raw : new JSONObject();
    switch (channel) {
      case "shellStorage":
        JSONObject values = body.optJSONObject("values");
        if (body.optString("scope").equals(selected)
            && values != null
            && values.toString().length() <= 1048576)
          prefs.edit().putString("state:" + selected, values.toString()).apply();
        reply.send(true);
        break;
      case "shellHosts":
        hosts(body, reply);
        break;
      case "shellKeyboard":
        if (body.optBoolean("dismiss"))
          ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
              .hideSoftInputFromWindow(root.getWindowToken(), 0);
        if (raw instanceof Boolean) shellEditing = (Boolean) raw;
        if (body.has("commands")) deviceKeys.register(body.optJSONArray("commands"));
        if (body.has("focusRequest")) {
          int token = body.optInt("focusRequest");
          int generation = launchGeneration;
          if (awaitingLaunchFocus) launchRequestedToken = token;
          evaluate(
              "window.HyprlandRemote?.focusFromNative(" + token + ",false)",
              result -> {
                if ("true".equals(result)) {
                  shell.requestFocus();
                  evaluate(
                      "window.HyprlandRemote?.focusFromNative(" + token + ",true)",
                      focused -> {
                        if (!"true".equals(focused)) return;
                        if (generation == launchGeneration) {
                          launchReadyToken = token;
                          drainLaunchKeys(token, generation);
                        }
                        if (body.optBoolean("keepKeyboardHidden"))
                          ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                              .hideSoftInputFromWindow(root.getWindowToken(), 0);
                        else if (getResources().getConfiguration().keyboard
                            != Configuration.KEYBOARD_QWERTY)
                          ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                              .showSoftInput(shell, InputMethodManager.SHOW_IMPLICIT);
                      });
                }
              });
        }
        reply.send(true);
        break;
      case "shellInstallBuild":
        if (selected.isEmpty() || directory.optBoolean("disconnected"))
          throw new IllegalStateException("Connect to a host before installing a build");
        String buildHost = selected;
        WebView buildShell = shell;
        deviceBuilds.install(
            origin(selected),
            body.optString("build"),
            () -> foreground && shell == buildShell && selected.equals(buildHost),
            result -> {
              if (shell == buildShell && !isDestroyed()) reply.send(result);
            });
        break;
      case "shellFiles":
        deviceFiles.dispatch(body, reply::send);
        break;
      case "weatherDevice":
        if (body.optString("action").equals("locale"))
          reply.send(
              object(
                  "unit",
                  Arrays.asList("US", "BS", "BZ", "KY", "PR", "PW")
                          .contains(Locale.getDefault().getCountry())
                      ? "f"
                      : "c"));
        else if (body.optString("action").equals("location"))
          deviceLocation.request(
              body.optBoolean("requestPermission"),
              (location, error) -> {
                if (error != null) reply.send(object("error", error));
                else
                  reply.send(
                      object(
                          "lat",
                          Math.round(location.getLatitude() * 100) / 100.0,
                          "lon",
                          Math.round(location.getLongitude() * 100) / 100.0,
                          "name",
                          "Current location"));
              });
        else throw new IllegalArgumentException("Unknown weather action");
        break;
      case "browserDevice":
        reply.send(browser(body));
        break;
      default:
        throw new IllegalArgumentException("Unsupported bridge");
    }
  }

  private void hosts(JSONObject body, Reply reply) {
    String action = body.optString("action");
    if (action.equals("prompt")) {
      LinearLayout form = new LinearLayout(this);
      form.setOrientation(LinearLayout.VERTICAL);
      EditText name = new EditText(this);
      name.setHint("Name (optional)");
      EditText address = new EditText(this);
      address.setHint("https://host.example");
      address.setInputType(
          android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
      form.addView(name);
      form.addView(address);
      new AlertDialog.Builder(this)
          .setTitle("Add host")
          .setView(form)
          .setNegativeButton("Cancel", (dialog, which) -> reply.send(directory))
          .setPositiveButton(
              "Save",
              (dialog, which) -> {
                try {
                  saveHost(name.getText().toString(), address.getText().toString());
                  reply.send(directory);
                } catch (Exception error) {
                  Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
                  reply.send(directory);
                }
              })
          .show();
      return;
    }
    if (action.equals("save")) saveHost(body.optString("name"), body.optString("url"));
    if (action.equals("remove")) {
      JSONArray result = new JSONArray();
      JSONArray hosts = directory.optJSONArray("hosts");
      for (int i = 0; hosts != null && i < hosts.length(); i++)
        if (!hosts.optJSONObject(i).optString("id").equals(body.optString("id")))
          result.put(hosts.optJSONObject(i));
      put(directory, "hosts", result);
      if (body.optString("id").equals(selected)) {
        selected = "";
        put(directory, "selected", "");
      }
    }
    boolean navigate =
        action.equals("connect") || action.equals("disconnect") || action.equals("manage");
    if (action.equals("connect")) {
      String id = body.optString("id");
      boolean found = false;
      JSONArray hosts = directory.optJSONArray("hosts");
      for (int i = 0; hosts != null && i < hosts.length(); i++)
        if (hosts.optJSONObject(i).optString("id").equals(id)) found = true;
      if (!found) throw new IllegalArgumentException("Unknown host");
      selected = normalize(id);
      put(directory, "selected", selected);
      put(directory, "disconnected", false);
    }
    if (action.equals("disconnect")) put(directory, "disconnected", true);
    persistHosts();
    reply.send(directory);
    if (navigate) handler.post(() -> loadShell(!action.equals("connect")));
  }

  private Object browser(JSONObject body) {
    String action = body.optString("action");
    if (action.equals("capabilities"))
      return object(
          "embedded",
          true,
          "webApps",
          true,
          "darkMode",
          true,
          "nativeFind",
          true,
          "shortcuts",
          true);
    String id = body.optString("appID", "browser");
    Page page = pages.get(id);
    if (action.equals("open")) {
      Uri url = Uri.parse(body.optString("url"));
      if (!http(url) || url.getHost() == null || url.getUserInfo() != null)
        throw new IllegalArgumentException("Unsupported website URL");
      if (page == null) {
        page = new Page(id);
        pages.put(id, page);
      }
      page.web.loadUrl(url.toString());
    } else if (page != null)
      switch (action) {
        case "layout":
          page.layout(body);
          break;
        case "back":
          if (page.web.canGoBack()) page.web.goBack();
          break;
        case "forward":
          if (page.web.canGoForward()) page.web.goForward();
          break;
        case "reload":
          page.web.reload();
          break;
        case "stop":
          page.web.stopLoading();
          break;
        case "focus":
          if (body.optBoolean("active", true)) page.web.requestFocus();
          else shell.requestFocus();
          break;
        case "close":
          page.closeFind();
          root.removeView(page.web);
          page.web.destroy();
          pages.remove(id);
          break;
        case "zoom":
          double requestedZoom = body.optDouble("value", 1);
          if (!Double.isFinite(requestedZoom)) break;
          page.zoom = Math.max(0.25, Math.min(5, requestedZoom));
          page.applyZoom();
          break;
        case "dark":
          page.dark = body.optBoolean("enabled");
          page.web.evaluateJavascript(
              "typeof window.DarkReader !== 'undefined'",
              available -> {
                Page current = pages.get(id);
                if (current == null) return;
                if ("true".equals(available)) pageDark(id);
                else
                  current.web.evaluateJavascript(
                      assetText("Web/vendor/darkreader/darkreader.js"), ignored -> pageDark(id));
              });
          return object("dark", page.dark);
        case "findOpen":
          page.openFind();
          break;
        case "findNext":
          if (page.findDialog == null) page.openFind();
          else page.web.findNext(!body.optBoolean("backwards"));
          break;
        case "findClose":
          return object("closed", page.closeFind());
        case "snapshot":
          page.snapshot();
          break;
        default:
          break;
      }
    return object("ok", true);
  }

  private void pageDark(String id) {
    Page page = pages.get(id);
    if (page != null)
      page.web.evaluateJavascript(
          page.dark
              ? "DarkReader.enable({brightness:100,contrast:100})"
              : "window.DarkReader?.disable()",
          null);
  }

  private final class Page {
    final String id;
    final WebView web;
    boolean dark;
    boolean loading;
    boolean hiddenControls;
    boolean requestedFocus;
    AlertDialog findDialog;
    String findQuery = "";
    float radius;
    double zoom = 1;

    Page(String id) {
      this.id = id;
      web = makeWebView();
      // Focusing the window must preserve the page's caret, not select its first field.
      web.getSettings().setNeedInitialFocus(false);
      web.setVisibility(View.GONE);
      web.setClipToOutline(true);
      web.setOutlineProvider(
          new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, android.graphics.Outline outline) {
              outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), radius);
            }
          });
      web.setOnTouchListener(
          (view, event) -> {
            if (event.getAction() == android.view.MotionEvent.ACTION_DOWN)
              emit(object("focused", true));
            return false;
          });
      web.setOnScrollChangeListener(
          (view, x, y, oldX, oldY) -> {
            boolean next = hiddenControls ? y > 0 : y > 12;
            if (!id.startsWith("webapp-") && next != hiddenControls) {
              hiddenControls = next;
              emit(object("controlsHidden", next));
            }
          });
      web.setWebViewClient(
          new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap icon) {
              loading = true;
              publish();
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
              publish();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
              loading = false;
              applyZoom();
              publish();
              if (dark)
                view.evaluateJavascript(
                    assetText("Web/vendor/darkreader/darkreader.js"), ignored -> pageDark(id));
              CookieManager.getInstance().flush();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
              if (http(request.getUrl())) return false;
              return true;
            }
          });
      root.addView(web, new FrameLayout.LayoutParams(1, 1));
    }

    // CSS zoom scales layout and images as well as text, including below the page's
    // pinch-zoom minimum. Keep authored root zoom intact when returning to 100%.
    void applyZoom() {
      web.evaluateJavascript(
          "(() => {"
              + "const root=document.documentElement;if(!root)return;"
              + "let saved=window.__omarchyPageZoom;"
              + "if(!saved || saved.root!==root){"
              + "saved={root,value:root.style.getPropertyValue('zoom'),"
              + "priority:root.style.getPropertyPriority('zoom'),"
              + "base:parseFloat(getComputedStyle(root).zoom)||1};"
              + "window.__omarchyPageZoom=saved;}"
              + "const factor="
              + zoom
              + ";"
              + "if(factor===1){"
              + "if(saved.value)root.style.setProperty('zoom',saved.value,saved.priority);"
              + "else root.style.removeProperty('zoom');"
              + "delete window.__omarchyPageZoom;"
              + "}else root.style.setProperty('zoom',String(saved.base*factor),'important');"
              + "})()",
          null);
    }

    void layout(JSONObject body) {
      boolean visible = body.optBoolean("visible");
      // Release focus before GONE clears ownership, otherwise the shell can look
      // focused in JavaScript while Android still has no input target.
      if (!visible) updateFocus(false);
      web.setVisibility(visible ? View.VISIBLE : View.GONE);
      if (!visible) {
        closeFind();
        return;
      }
      JSONArray rect = body.optJSONArray("rect");
      double viewport = body.optDouble("viewport");
      if (rect == null || rect.length() != 4 || viewport <= 0) return;
      float scale = (float) (root.getWidth() / viewport);
      int width = Math.max(1, (int) (rect.optDouble(2) * scale));
      int height = Math.max(1, (int) (rect.optDouble(3) * scale));
      if (width > root.getWidth() * 4 || height > root.getHeight() * 4) return;
      FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) web.getLayoutParams();
      if (params.width != width || params.height != height) {
        params.width = width;
        params.height = height;
        web.setLayoutParams(params);
      }
      web.setTranslationX((float) rect.optDouble(0) * scale);
      web.setTranslationY((float) rect.optDouble(1) * scale);
      web.setAlpha((float) body.optDouble("opacity", 1));
      radius = (float) body.optDouble("radius") * scale;
      web.invalidateOutline();
      updateFocus(body.optBoolean("focused"));
    }

    void updateFocus(boolean focused) {
      boolean gainingFocus = focused && !requestedFocus;
      requestedFocus = focused;
      if (!focused) {
        // Only relinquish this page; sibling layout messages can arrive in either order.
        if (web.hasFocus()) shell.requestFocus();
      } else if (gainingFocus
          && getResources().getConfiguration().keyboard == Configuration.KEYBOARD_QWERTY) {
        // Layout animation frames must not steal focus back from page controls/dialogs.
        web.requestFocus();
      }
    }

    void openFind() {
      if (web.getVisibility() != View.VISIBLE) return;
      if (findDialog != null) return;
      LinearLayout content = new LinearLayout(ShellActivity.this);
      content.setOrientation(LinearLayout.VERTICAL);
      int padding = (int) (20 * getResources().getDisplayMetrics().density);
      content.setPadding(padding, padding / 2, padding, 0);
      EditText query = new EditText(ShellActivity.this);
      query.setSingleLine(true);
      query.setHint("Find in page");
      query.setContentDescription("Find in page");
      query.setText(findQuery);
      TextView count = new TextView(ShellActivity.this);
      count.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
      content.addView(query);
      content.addView(count);
      web.setFindListener(
          (index, total, done) -> {
            if (done) count.setText(total == 0 ? "No matches" : (index + 1) + " of " + total);
          });
      query.addTextChangedListener(
          new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence text, int start, int length, int after) {}

            public void onTextChanged(CharSequence text, int start, int before, int length) {
              findQuery = text.toString();
              web.findAllAsync(findQuery);
            }

            public void afterTextChanged(android.text.Editable text) {}
          });
      findDialog =
          new AlertDialog.Builder(ShellActivity.this)
              .setTitle("Find in page")
              .setView(content)
              .setNegativeButton("Previous", null)
              .setNeutralButton("Next", null)
              .setPositiveButton("Done", (dialog, which) -> {})
              .create();
      findDialog.setOnDismissListener(
          dialog -> {
            web.clearMatches();
            web.setFindListener(null);
            findDialog = null;
          });
      findDialog.setOnShowListener(
          dialog -> {
            findDialog
                .getButton(AlertDialog.BUTTON_NEGATIVE)
                .setOnClickListener(view -> web.findNext(false));
            findDialog
                .getButton(AlertDialog.BUTTON_NEUTRAL)
                .setOnClickListener(view -> web.findNext(true));
            query.requestFocus();
            query.selectAll();
            web.findAllAsync(findQuery);
          });
      findDialog.show();
    }

    boolean closeFind() {
      if (findDialog == null) return false;
      findDialog.dismiss();
      return true;
    }

    void emit(JSONObject data) {
      if (!id.equals("browser")) put(data, "appID", id);
      evaluate(
          "window.dispatchEvent(new CustomEvent('host-browser-state',{detail:" + data + "}));",
          null);
    }

    void publish() {
      emit(
          object(
              "url",
              web.getUrl(),
              "title",
              web.getTitle(),
              "loading",
              loading,
              "back",
              web.canGoBack(),
              "forward",
              web.canGoForward()));
    }

    void snapshot() {
      if (web.getWidth() < 1 || web.getHeight() < 1 || web.getVisibility() != View.VISIBLE) return;
      Bitmap image =
          Bitmap.createBitmap(
              Math.min(web.getWidth(), 600),
              Math.min(web.getHeight(), 900),
              Bitmap.Config.ARGB_8888);
      Canvas canvas = new Canvas(image);
      canvas.scale(
          (float) image.getWidth() / web.getWidth(), (float) image.getHeight() / web.getHeight());
      web.draw(canvas);
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      image.compress(Bitmap.CompressFormat.JPEG, 65, bytes);
      image.recycle();
      emit(
          object(
              "preview",
              "data:image/jpeg;base64,"
                  + android.util.Base64.encodeToString(
                      bytes.toByteArray(), android.util.Base64.NO_WRAP)));
    }
  }

  private void evaluate(String code, ValueCallback<String> callback) {
    if (shell != null) shell.evaluateJavascript(code, callback);
  }

  private void publishBattery(int percent, int state) {
    String name =
        state == BatteryManager.BATTERY_STATUS_FULL
            ? "full"
            : state == BatteryManager.BATTERY_STATUS_CHARGING ? "charging" : "unplugged";
    evaluate(
        "window.__HYPRLAND_BATTERY__="
            + object("percent", percent, "state", name)
            + ";window.dispatchEvent(new Event('hyprland-battery'));",
        null);
  }

  private void publishHardwareKeyboard() {
    boolean hardware = getResources().getConfiguration().keyboard == Configuration.KEYBOARD_QWERTY;
    evaluate(
        "window.__HYPRLAND_HARDWARE_KEYBOARD__="
            + hardware
            + ";window.dispatchEvent(new Event('hyprland-hardware-keyboard'));",
        null);
  }

  @Override
  public void onConfigurationChanged(Configuration configuration) {
    super.onConfigurationChanged(configuration);
    publishHardwareKeyboard();
  }

  @Override
  public void onBackPressed() {
    WindowInsets insets = root.getRootWindowInsets();
    if (insets != null && insets.isVisible(WindowInsets.Type.ime())) {
      ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
          .hideSoftInputFromWindow(root.getWindowToken(), 0);
      evaluate("window.HyprlandDesk?.nativeBack({keyboard:true})", null);
      return;
    }
    evaluate(
        "window.HyprlandDesk?.nativeBack()",
        handled -> {
          if ("true".equals(handled) || !foreground) return;
          for (Page page : pages.values()) {
            if (page.web.hasFocus()
                && page.web.getVisibility() == View.VISIBLE
                && page.web.canGoBack()) {
              page.web.goBack();
              return;
            }
          }
          moveTaskToBack(true);
        });
  }

  private void cancelLaunchFocus() {
    handler.removeCallbacks(abandonLaunchKeys);
    awaitingLaunchFocus = false;
    replayingLaunchKeys = false;
    launchRequestedToken = 0;
    launchReadyToken = 0;
    launchGeneration++;
    launchKeys.clear();
  }

  private void drainLaunchKeys(int token, int generation) {
    if (!awaitingLaunchFocus
        || replayingLaunchKeys
        || generation != launchGeneration
        || token == 0
        || token != launchRequestedToken
        || token != launchReadyToken) return;
    if (launchKeys.isEmpty()) {
      cancelLaunchFocus();
      return;
    }
    ArrayList<KeyEvent> batch = new ArrayList<>(launchKeys);
    JSONArray keys = new JSONArray();
    for (KeyEvent event : batch) {
      if (event.getAction() != KeyEvent.ACTION_DOWN) continue;
      String special =
          switch (event.getKeyCode()) {
            case KeyEvent.KEYCODE_ENTER -> "Enter";
            case KeyEvent.KEYCODE_DEL -> "Backspace";
            case KeyEvent.KEYCODE_TAB -> "Tab";
            default -> null;
          };
      if (special != null) keys.put(object("code", special));
      else {
        int character = event.getUnicodeChar();
        if (Character.isValidCodePoint(character))
          keys.put(object("text", new String(Character.toChars(character))));
      }
    }
    launchKeys.clear();
    replayingLaunchKeys = true;
    evaluate(
        "window.HyprlandRemote?.replayInput(" + token + "," + keys + ")",
        result -> {
          if (generation != launchGeneration) return;
          replayingLaunchKeys = false;
          if (!"true".equals(result)) {
            if (token == launchRequestedToken) {
              cancelLaunchFocus();
              return;
            }
            launchKeys.addAll(0, batch);
          }
          drainLaunchKeys(launchReadyToken, generation);
        });
  }

  private boolean bufferTransitionKey(KeyEvent event) {
    int key = event.getKeyCode();
    if (!awaitingLaunchFocus
        || consumedKeys.contains(key)
        || event.isCtrlPressed()
        || event.isAltPressed()
        || event.isMetaPressed()) return false;
    if (event.getUnicodeChar() < 32
        && key != KeyEvent.KEYCODE_ENTER
        && key != KeyEvent.KEYCODE_DEL
        && key != KeyEvent.KEYCODE_TAB) return false;
    if (launchKeys.size() < 256) launchKeys.add(new KeyEvent(event));
    return true;
  }

  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    int key = event.getKeyCode();
    if (key == KeyEvent.KEYCODE_BACK) {
      if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) onBackPressed();
      return true;
    }
    if (event.getAction() == KeyEvent.ACTION_UP && consumedKeys.remove(key)) return true;
    if (shell == null) return super.dispatchKeyEvent(event);
    if (bufferTransitionKey(event)) return true;
    if (event.getAction() != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event);
    if (event.getRepeatCount() > 0 && consumedKeys.contains(key)) return true;
    boolean pageFocused =
        pages.values().stream()
            .anyMatch(page -> page.web.hasFocus() && page.web.getVisibility() == View.VISIBLE);
    JSONObject action = deviceKeys.match(event, shellEditing || pageFocused);
    if (action == null) return super.dispatchKeyEvent(event);
    consumedKeys.add(key);
    cancelLaunchFocus();
    if (action.optBoolean("focusShell")) shell.requestFocus();
    boolean windowTransition =
        !pageFocused
            && action.optString("owner").equals("shell")
            && (action.optString("group").equals("Windows")
                || action.optString("group").equals("Workspaces"));
    if ((action.optBoolean("focusShell") && action.optString("group").equals("Apps"))
        || windowTransition) {
      awaitingLaunchFocus = true;
      handler.postDelayed(abandonLaunchKeys, 2000);
    }
    // Send the registry chord, including the canonical form of Ctrl+Alt shell aliases.
    evaluate(
        "window.HyprlandDesk?.nativeKey("
            + action
            + ");"
            + (awaitingLaunchFocus ? "window.HyprlandRemote?.requestInputFocus();" : ""),
        null);
    return true;
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == DeviceFiles.SAVE_REQUEST) deviceFiles.result(result, data);
    if (request == 10 && fileCallback != null) {
      ValueCallback<Uri[]> callback = fileCallback;
      fileCallback = null;
      // Multi-selection is returned as ClipData, with no single data URI.
      // Some WebView versions' default parser only reads the single URI.
      if (result == RESULT_OK && data != null && data.getClipData() != null) {
        ArrayList<Uri> selected = new ArrayList<>();
        for (int index = 0; index < data.getClipData().getItemCount(); index++) {
          Uri uri = data.getClipData().getItemAt(index).getUri();
          if (uri != null) selected.add(uri);
        }
        callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
      } else {
        callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
      }
    }
  }

  @Override
  public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(request, permissions, results);
    if (request == DeviceLocation.PERMISSION_REQUEST) deviceLocation.permissionResult();
  }

  @Override
  protected void onDestroy() {
    foreground = false;
    handler.removeCallbacks(reconnect);
    deviceLocation.cancel();
    deviceFiles.cancel();
    unregisterReceiver(battery);
    if (fileCallback != null) fileCallback.onReceiveValue(null);
    for (Page page : pages.values()) {
      page.closeFind();
      page.web.destroy();
    }
    if (shell != null) shell.destroy();
    super.onDestroy();
  }

  static JSONObject json(String value) {
    try {
      return new JSONObject(value == null ? "{}" : value);
    } catch (JSONException error) {
      return new JSONObject();
    }
  }

  static JSONObject object(Object... values) {
    JSONObject result = new JSONObject();
    for (int i = 0; i < values.length; i += 2) put(result, (String) values[i], values[i + 1]);
    return result;
  }

  static void put(JSONObject target, String key, Object value) {
    try {
      target.put(key, value == null ? JSONObject.NULL : value);
    } catch (JSONException error) {
      throw new IllegalArgumentException(error);
    }
  }
}
