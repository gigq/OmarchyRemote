import UIKit
import WebKit
import OSLog
import CoreLocation

/// Where the live shell comes from: the `OmarchyRemoteURL` Info.plist key (the address the
/// backend is published at, for example a Tailscale Serve URL). Debug builds load it and
/// fall back to the bundled copy; page-to-app bridges only answer that origin or the bundle.
enum ShellSource {
    static let liveURL: URL? = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "OmarchyRemoteURL") as? String,
              let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)), url.host != nil else { return nil }
        return url
    }()
    static var hostLabel: String { liveURL?.host ?? "the host" }
    static func trusts(_ origin: WKSecurityOrigin) -> Bool {
        guard let live = liveURL, let scheme = live.scheme, let host = live.host else { return false }
        let port = live.port ?? (scheme == "https" ? 443 : 80)
        return origin.protocol == scheme && origin.host == host && origin.port == port
    }
}

@MainActor
private final class ShellWebView: WKWebView {
    // The shell supplies its own mode and dismissal controls above the keyboard.
    override var inputAccessoryView: UIView? { nil }
    override var inputAssistantItem: UITextInputAssistantItem {
        let item = super.inputAssistantItem
        if traitCollection.userInterfaceIdiom == .pad {
            item.leadingBarButtonGroups = []
            item.trailingBarButtonGroups = []
        }
        return item
    }
}

@MainActor
private final class WeatherDeviceBridge: NSObject, WKScriptMessageHandlerWithReply, CLLocationManagerDelegate {
    private lazy var manager: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
        return manager
    }()
    private let geocoder = CLGeocoder()
    private var pending: (@MainActor @Sendable (Any?, String?) -> Void)?
    private var timeout: DispatchWorkItem?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              ShellSource.trusts(origin) || message.frameInfo.request.url?.isFileURL == true,
              let body = message.body as? [String: Any] else {
            replyHandler(nil, "Unsupported page")
            return
        }
        if body["action"] as? String == "locale" {
            let unit = UnitTemperature(forLocale: .current)
            replyHandler(["unit": unit == .fahrenheit ? "f" : "c", "locale": Locale.current.identifier], nil)
            return
        }
        guard body["action"] as? String == "location" else { replyHandler(nil, "Unknown request"); return }
        guard pending == nil else { replyHandler(nil, "Location request already in progress"); return }
        pending = replyHandler
        let timer = DispatchWorkItem { [weak self] in self?.finish(nil, error: "Location timed out. Try again or choose a city.") }
        timeout = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: timer)
        if manager.authorizationStatus == .notDetermined {
            if body["requestPermission"] as? Bool == true { manager.requestWhenInUseAuthorization() }
            else { finish(nil, error: "Tap Use phone location to allow location access.") }
        } else { requestAuthorizedLocation() }
    }
    private func requestAuthorizedLocation() {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
        case .denied, .restricted: finish(nil, error: "Location access is off. Enable it in iOS Settings or choose a city.")
        default: break
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if pending != nil { requestAuthorizedLocation() }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard pending != nil, let location = locations.last, location.horizontalAccuracy >= 0 else { return }
        let coordinate = location.coordinate
        // City-level coordinates are enough for a weather forecast.
        let lat = (coordinate.latitude * 100).rounded() / 100
        let lon = (coordinate.longitude * 100).rounded() / 100
        geocoder.reverseGeocodeLocation(location) { [weak self] places, _ in
            Task { @MainActor in
                let name = places?.first?.locality ?? places?.first?.subAdministrativeArea ?? "Current location"
                self?.finish(["lat": lat, "lon": lon, "name": name], error: nil)
            }
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .locationUnknown { return }
        finish(nil, error: "Could not find your location. Try again or choose a city.")
    }
    private func finish(_ value: [String: Any]?, error: String?) {
        let reply = pending
        pending = nil
        timeout?.cancel()
        timeout = nil
        manager.stopUpdatingLocation()
        geocoder.cancelGeocode()
        reply?(value, error)
    }
}

@MainActor
private final class BrowserDeviceBridge: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate, UIGestureRecognizerDelegate {
    weak var presenter: UIViewController?
    weak var shell: WKWebView?
    private var page: WKWebView?
    private var observations: [NSKeyValueObservation] = []
    private var requestedVisible = false
    private var controlsHidden = false
    private var forceDark = UserDefaults.standard.bool(forKey: "browserForceDark")
    private let darkWorld = WKContentWorld.world(name: "BrowserAppearance")
    private lazy var darkSource: String? = {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("Web/vendor/darkreader/darkreader.js") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }()
    private func darkScript(_ enabled: Bool) -> String {
        guard let darkSource else { return "" }
        return "if (!globalThis.DarkReader) {\n" + darkSource + "\n}\n" +
            (enabled ? "DarkReader.setFetchMethod(window.fetch.bind(window)); DarkReader.enable({brightness:100,contrast:100,sepia:0}, {disableStyleSheetsProxy:true,disableCustomElementRegistryProxy:true});" : "DarkReader.disable();")
    }
    private func configureDarkScripts(_ browser: WKWebView) {
        let controller = browser.configuration.userContentController
        controller.removeAllUserScripts()
        if forceDark, darkSource != nil {
            controller.addUserScript(WKUserScript(source: darkScript(true), injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: darkWorld))
        }
    }

    private var panY: CGFloat = 0
    private var scrollTravel: CGFloat = 0

    func reset() {
        observations.removeAll()
        page?.stopLoading()
        page?.removeFromSuperview()
        page = nil
        requestedVisible = false
    }
    private func ensurePage() -> WKWebView? {
        if let page { return page }
        guard let presenter else { return nil }
        let configuration = WKWebViewConfiguration()
        // Independent website storage; appearance script runs in an isolated world, with no host handlers.
        configuration.websiteDataStore = .default()
        let browser = WKWebView(frame: .zero, configuration: configuration)
        configureDarkScripts(browser)
        browser.navigationDelegate = self
        browser.uiDelegate = self
        browser.isHidden = true
        browser.layer.cornerRadius = 12
        browser.clipsToBounds = true
        browser.scrollView.contentInsetAdjustmentBehavior = .never
        browser.scrollView.panGestureRecognizer.addTarget(self, action: #selector(pageScrolled(_:)))
        browser.allowsBackForwardNavigationGestures = true
        browser.accessibilityIdentifier = "hyprland.browser.page"
        let focus = UITapGestureRecognizer()
        focus.delegate = self
        browser.addGestureRecognizer(focus)
        presenter.view.addSubview(browser)
        page = browser
        observations = [browser.observe(\.url, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.publish() } },
                        browser.observe(\.isLoading, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.publish() } }]
        return browser
    }
    private func showControls(_ hidden: Bool) {
        guard controlsHidden != hidden else { return }
        controlsHidden = hidden
        publish(controlsHidden: hidden)
    }
    @objc private func pageScrolled(_ pan: UIPanGestureRecognizer) {
        guard let page, !page.isHidden else { return }
        let y = pan.translation(in: page).y
        if pan.state == .began { panY = y; scrollTravel = 0; return }
        guard pan.state == .changed else { return }
        let delta = y - panY
        panY = y
        if delta * scrollTravel < 0 { scrollTravel = 0 }
        scrollTravel += delta
        if page.scrollView.contentOffset.y <= 0 || scrollTravel > 20 { showControls(false) }
        else if scrollTravel < -40 && page.scrollView.contentSize.height > page.bounds.height { showControls(true) }
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        if let page, touch.location(in: page).y < 24 { showControls(false) }
        publish(focused: true)
        return false // Observe focus without recognizing or cancelling website touches.
    }
    private func publish(error: String? = nil, preview: String? = nil, focused: Bool = false, controlsHidden: Bool? = nil) {
        guard let page else { return }
        var state: [String: Any] = ["url": page.url?.absoluteString ?? "", "back": page.canGoBack, "forward": page.canGoForward, "loading": page.isLoading]
        if let controlsHidden { state["controlsHidden"] = controlsHidden }
        if focused { state["focused"] = true }
        if let error { state["error"] = error }
        if let preview { state["preview"] = preview }
        shell?.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('host-browser-state', {detail: state}))", arguments: ["state": state], in: nil, in: .page, completionHandler: nil)
    }
    private func snapshot() {
        guard let page, !page.isHidden, !page.isLoading, !page.bounds.isEmpty else { return }
        let capturedURL = page.url
        let config = WKSnapshotConfiguration()
        config.snapshotWidth = 600
        page.takeSnapshot(with: config) { [weak self, weak page] image, _ in
            guard let self, let page, self.page === page, !page.isHidden, page.url == capturedURL, let data = image?.jpegData(compressionQuality: 0.65) else { return }
            self.publish(preview: "data:image/jpeg;base64," + data.base64EncodedString())
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.webView === shell, message.frameInfo.isMainFrame,
              ShellSource.trusts(message.frameInfo.securityOrigin) || message.frameInfo.request.url?.isFileURL == true,
              let body = message.body as? [String: Any] else { replyHandler(nil, "Unsupported page"); return }
        let action = body["action"] as? String ?? "open"
        if action == "capabilities" { replyHandler(["embedded": true, "darkMode": darkSource != nil, "dark": forceDark], nil); return }
        if action == "close" { reset(); replyHandler(["closed": true], nil); return }
        if action == "layout" {
            guard let page, let presenter else { replyHandler(["visible": false], nil); return }
            let visible = body["visible"] as? Bool == true
            if !visible {
                requestedVisible = false
                page.endEditing(true)
                page.isHidden = true
                replyHandler(["visible": false], nil)
                return
            }
            guard let rect = body["rect"] as? [Double], rect.count == 4, rect.allSatisfy({ $0.isFinite }),
                  let viewport = body["viewport"] as? Double, viewport.isFinite, viewport > 0,
                  rect[2] > 0, rect[3] > 0 else { page.isHidden = true; replyHandler(nil, "Invalid bounds"); return }
            let scale = presenter.view.bounds.width / viewport
            let frame = CGRect(x: rect[0] * scale, y: rect[1] * scale, width: rect[2] * scale, height: rect[3] * scale).intersection(presenter.view.bounds)
            if let hidden = body["controlsHidden"] as? Bool { controlsHidden = hidden }
            page.frame = frame
            if let radius = body["radius"] as? Double, radius.isFinite { page.layer.cornerRadius = max(0, min(24, radius * scale)) }
            page.layer.maskedCorners = body["roundedTop"] as? Bool == true ? [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner] : [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
            requestedVisible = !frame.isEmpty && !frame.isNull
            page.isHidden = !requestedVisible
            if let rgb = body["background"] as? [Double], rgb.count == 3, rgb.allSatisfy({ $0.isFinite && (0...255).contains($0) }) {
                let color = UIColor(red: rgb[0]/255, green: rgb[1]/255, blue: rgb[2]/255, alpha: 1)
                page.underPageBackgroundColor = color
                page.backgroundColor = color
            }
            replyHandler(["visible": requestedVisible], nil)
            return
        }
        guard let page = ensurePage() else { replyHandler(nil, "Browser unavailable"); return }
        switch action {
        case "open":
            guard let raw = body["url"] as? String, let url = URL(string: raw), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { replyHandler(nil, "Use an http or https URL"); return }
            page.load(URLRequest(url: url))
        case "dark":
            guard let enabled = body["enabled"] as? Bool, darkSource != nil else { replyHandler(nil, "Dark mode unavailable"); return }
            page.evaluateJavaScript(darkScript(enabled), in: nil, in: darkWorld) { [weak self, weak page] result in
                guard let self, let page, self.page === page else { replyHandler(nil, "Page closed"); return }
                switch result {
                case .failure(let error): replyHandler(nil, error.localizedDescription)
                case .success:
                    self.forceDark = enabled
                    UserDefaults.standard.set(enabled, forKey: "browserForceDark")
                    self.configureDarkScripts(page)
                    self.snapshot()
                    replyHandler(["dark": enabled], nil)
                }
            }
            return
        case "snapshot": snapshot()
        case "back": page.goBack()
        case "forward": page.goForward()
        case "reload": page.reload()
        default: replyHandler(nil, "Unknown browser action"); return
        }
        replyHandler(["opened": true], nil)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = ["http", "https", "about"].contains(navigationAction.request.url?.scheme?.lowercased() ?? "")
        if !allowed { publish(error: "This link requires an external app.") }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") { webView.load(navigationAction.request) }
        return nil
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { controlsHidden = false; publish(controlsHidden: false) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { publish(); snapshot() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { publish(error: error.localizedDescription) } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { publish(error: error.localizedDescription) } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { publish(error: "Page stopped. Tap Reload to restore it.") }
}

@MainActor
final class ShellViewController: UIViewController, WKNavigationDelegate {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "HyprlandTouch", category: "Shell")
    private let background = UIColor(red: 25 / 255, green: 23 / 255, blue: 36 / 255, alpha: 1)
    private var webView: WKWebView!
    private let weatherDevice = WeatherDeviceBridge()
    private let browserDevice = BrowserDeviceBridge()
    private var lastKeyboardGeometry: [Double]?
    private let keyboardProbe = UIView()
    private var webRoot: URL?
    private let retryButton = UIButton(type: .system)
    private let sourceButton = UIButton(type: .system)
    private var remoteNavigation: WKNavigation?
    private var loadGeneration = 0
    private var loadTimeout: DispatchWorkItem?
    private var usingOfflineFallback = false
    private var developmentURL: URL? {
        #if DEBUG
        ShellSource.liveURL
        #else
        nil
        #endif
    }
    private var prefersBundle: Bool {
        UserDefaults.standard.bool(forKey: "useBundledPrototype") || ProcessInfo.processInfo.arguments.contains("--bundled")
    }

    override var prefersStatusBarHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { [.top, .bottom] }
    // Keep the system's dimmed escape indicator when bottom-edge deferral is active.
    override var prefersHomeIndicatorAutoHidden: Bool { false }
    // iPhone keeps the portrait phone shell; iPad rotates freely and the web shell relays out in desk mode.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        traitCollection.userInterfaceIdiom == .pad ? .all : .portrait
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = background

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        browserDevice.presenter = self
        configuration.userContentController.addScriptMessageHandler(browserDevice, contentWorld: .page, name: "browserDevice")
        configuration.userContentController.addScriptMessageHandler(weatherDevice, contentWorld: .page, name: "weatherDevice")
        webView = ShellWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.underPageBackgroundColor = background
        webView.scrollView.backgroundColor = background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.allowsBackForwardNavigationGestures = false
        webView.accessibilityIdentifier = "hyprland.webview"
        #if DEBUG
        webView.isInspectable = true
        #endif
        view.addSubview(webView)
        browserDevice.shell = webView
        if traitCollection.userInterfaceIdiom == .pad {
            // Track docked keyboard coverage, not WebKit's sometimes-stale visual viewport.
            view.keyboardLayoutGuide.followsUndockedKeyboard = false
            keyboardProbe.translatesAutoresizingMaskIntoConstraints = false
            keyboardProbe.isUserInteractionEnabled = false
            keyboardProbe.accessibilityElementsHidden = true
            view.addSubview(keyboardProbe)
            NSLayoutConstraint.activate([
                keyboardProbe.topAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
                keyboardProbe.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                keyboardProbe.widthAnchor.constraint(equalToConstant: 0),
                keyboardProbe.heightAnchor.constraint(equalToConstant: 0)
            ])
        }
        // Deliberately use the view edges, not the safe-area guide.
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        retryButton.setTitle("Couldn’t open Hyprland. Tap to retry.", for: .normal)
        retryButton.setTitleColor(.white, for: .normal)
        retryButton.titleLabel?.numberOfLines = 0
        retryButton.titleLabel?.textAlignment = .center
        retryButton.backgroundColor = background
        retryButton.translatesAutoresizingMaskIntoConstraints = false
        retryButton.isHidden = true
        retryButton.addTarget(self, action: #selector(loadShell), for: .touchUpInside)
        view.addSubview(retryButton)
        NSLayoutConstraint.activate([
            retryButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            retryButton.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            retryButton.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
            retryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 56)
        ])
        sourceButton.setTitle("Offline copy · Retry live", for: .normal)
        sourceButton.setTitleColor(.white, for: .normal)
        sourceButton.titleLabel?.font = .preferredFont(forTextStyle: .caption1)
        sourceButton.backgroundColor = background
        sourceButton.layer.cornerRadius = 12
        sourceButton.translatesAutoresizingMaskIntoConstraints = false
        sourceButton.isHidden = true
        sourceButton.accessibilityIdentifier = "hyprland.retryLive"
        sourceButton.addTarget(self, action: #selector(retryLive), for: .touchUpInside)
        view.addSubview(sourceButton)
        NSLayoutConstraint.activate([
            sourceButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            sourceButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            sourceButton.widthAnchor.constraint(equalToConstant: 240),
            sourceButton.heightAnchor.constraint(equalToConstant: 44)
        ])
        if developmentURL != nil {
            let sourceGesture = UILongPressGestureRecognizer(target: self, action: #selector(showSourceMenu(_:)))
            sourceGesture.numberOfTouchesRequired = 2
            sourceGesture.minimumPressDuration = 0.8
            sourceGesture.cancelsTouchesInView = false
            view.addGestureRecognizer(sourceGesture)
            NotificationCenter.default.addObserver(self, selector: #selector(resumeLive), name: UIApplication.willEnterForegroundNotification, object: nil)
        }
        loadShell()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        publishKeyboardGeometry()
    }

    private func publishKeyboardGeometry(force: Bool = false) {
        guard traitCollection.userInterfaceIdiom == .pad, let webView, view.bounds.height > 0 else { return }
        let covered = max(0, view.bounds.maxY - view.keyboardLayoutGuide.layoutFrame.minY)
        // A floating keyboard/shortcut strip doesn't reserve the whole bottom of the desk.
        let inset = covered > 80 ? covered : 0
        let geometry = [Double(inset), Double(view.bounds.height)]
        guard force || geometry != lastKeyboardGeometry else { return }
        lastKeyboardGeometry = geometry
        webView.callAsyncJavaScript(
            "window.__HYPRLAND_KEYBOARD__ = geometry; window.dispatchEvent(new Event('hyprland-keyboard'));",
            arguments: ["geometry": ["inset": geometry[0], "height": geometry[1]]],
            in: nil, in: .page, completionHandler: nil)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        setNeedsStatusBarAppearanceUpdate()
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
    }

    @objc private func loadShell() {
        loadGeneration += 1
        loadTimeout?.cancel()
        remoteNavigation = nil
        usingOfflineFallback = false
        sourceButton.isHidden = true
        retryButton.isHidden = true
        if let url = developmentURL, !prefersBundle {
            let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
            remoteNavigation = webView.load(request)
            let generation = loadGeneration
            let timeout = DispatchWorkItem { [weak self] in
                guard self?.loadGeneration == generation else { return }
                self?.fallBackToBundle()
            }
            loadTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 9, execute: timeout)
        } else {
            loadBundledShell()
        }
    }

    private func loadBundledShell() {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) else {
            retryButton.isHidden = false
            logger.error("Bundled Web/index.html is missing")
            return
        }
        webRoot = root
        retryButton.isHidden = true
        webView.loadFileURL(root.appendingPathComponent("index.html"), allowingReadAccessTo: root)
    }

    private func fallBackToBundle() {
        guard !usingOfflineFallback, !prefersBundle, developmentURL != nil else { return }
        loadGeneration += 1
        loadTimeout?.cancel()
        remoteNavigation = nil
        webView.stopLoading()
        usingOfflineFallback = true
        sourceButton.isHidden = false
        logger.notice("Live shell unavailable; using bundled copy")
        loadBundledShell()
    }

    @objc private func retryLive() {
        UserDefaults.standard.set(false, forKey: "useBundledPrototype")
        loadShell()
    }

    @objc private func resumeLive() {
        if usingOfflineFallback && !prefersBundle { loadShell() }
    }

    @objc private func showSourceMenu(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, presentedViewController == nil else { return }
        let menu = UIAlertController(title: "Prototype source", message: "Live mode loads the shell from \(ShellSource.hostLabel) and reloads when its files change. Connect to that host's network (for example Tailscale) to use it.", preferredStyle: .actionSheet)
        menu.addAction(UIAlertAction(title: "Live from \(ShellSource.hostLabel)", style: .default) { [weak self] _ in self?.retryLive() })
        menu.addAction(UIAlertAction(title: "Bundled offline copy", style: .default) { [weak self] _ in
            UserDefaults.standard.set(true, forKey: "useBundledPrototype")
            self?.loadShell()
        })
        menu.addAction(UIAlertAction(title: "Reload", style: .default) { [weak self] _ in self?.loadShell() })
        menu.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        present(menu, animated: true)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { browserDevice.reset() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryButton.isHidden = true
        publishKeyboardGeometry(force: true)
        if webView.url?.isFileURL == true {
            loadTimeout?.cancel()
            remoteNavigation = nil
            logger.info("Loaded Hyprland shell: bundled")
        } else if !usingOfflineFallback {
            verifyLiveShell(generation: loadGeneration, attemptsRemaining: 12)
        }
    }

    // A completed HTTP navigation can still be a proxy error or a JS boot failure.
    // Only call the live source ready once the rendered shell actually exists.
    private func verifyLiveShell(generation: Int, attemptsRemaining: Int) {
        webView.evaluateJavaScript("Boolean(document.querySelector('#touch-shell') && !document.querySelector('#touch-shell').closest('x-dc'))") { [weak self] result, _ in
            guard let self, self.loadGeneration == generation, !self.usingOfflineFallback else { return }
            if result as? Bool == true {
                self.loadTimeout?.cancel()
                self.remoteNavigation = nil
                self.logger.info("Loaded Hyprland shell: live from \(ShellSource.hostLabel) (rendered)")
            } else if attemptsRemaining > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    self?.verifyLiveShell(generation: generation, attemptsRemaining: attemptsRemaining - 1)
                }
            } else {
                self.fallBackToBundle()
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        logger.error("Web content process terminated; offering reload")
        retryButton.isHidden = false
    }

    private func showLoadFailure(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        logger.error("Shell load failed: \(error.localizedDescription, privacy: .public)")
        if remoteNavigation != nil || (webView.url?.scheme == "https" && !usingOfflineFallback) { fallBackToBundle(); return }
        retryButton.isHidden = false
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if let live = developmentURL,
           url.scheme == live.scheme, url.host == live.host, url.port == live.port {
            decisionHandler(.allow)
        } else if url.isFileURL, let root = webRoot,
           url.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/") {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated,
               ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           !(200..<300).contains(response.statusCode) {
            logger.error("Live server returned HTTP \(response.statusCode)")
            decisionHandler(.cancel)
            fallBackToBundle()
        } else {
            decisionHandler(.allow)
        }
    }
}
