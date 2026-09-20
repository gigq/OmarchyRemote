import UIKit
import UIKit.UIGestureRecognizerSubclass
import WebKit
import OSLog
import CoreLocation
import GameController

/// The connection directory belongs to this device, independently of host-backed preferences.
@MainActor
enum ShellSource {
    private static let directoryKey = "omarchyHostDirectory"
    static func normalize(_ raw: String) -> URL? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: text.contains("://") ? text : "https://" + text),
            let host = parts.host, !host.isEmpty,
            parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host)),
            parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
            ["", "/", "/native", "/native/"].contains(parts.path)
        else { return nil }
        parts.host = host.lowercased()
        if parts.port == (parts.scheme == "https" ? 443 : 80) { parts.port = nil }
        parts.path = "/native/"
        return parts.url
    }
    static var directory: [String: Any] {
        get {
            if let saved = UserDefaults.standard.dictionary(forKey: directoryKey) { return saved }
            let raw = Bundle.main.object(forInfoDictionaryKey: "OmarchyRemoteURL") as? String ?? ""
            let url = normalize(raw)
            let hosts: [[String: String]] =
                url.map { [["id": $0.absoluteString, "url": $0.absoluteString, "name": $0.host ?? "Host"]] } ?? []
            let initial: [String: Any] = ["hosts": hosts, "selected": url?.absoluteString ?? ""]
            UserDefaults.standard.set(initial, forKey: directoryKey)
            return initial
        }
        set { UserDefaults.standard.set(newValue, forKey: directoryKey) }
    }
    static var liveURL: URL? {
        guard let selected = directory["selected"] as? String,
            let hosts = directory["hosts"] as? [[String: String]],
            let host = hosts.first(where: { $0["id"] == selected }), let raw = host["url"]
        else { return nil }
        return normalize(raw)
    }
    static var scope: String { liveURL?.absoluteString ?? "" }
    static var hostLabel: String { liveURL?.host ?? "the host" }
    static func trusts(_ origin: WKSecurityOrigin) -> Bool {
        guard let live = liveURL, let scheme = live.scheme, let host = live.host else { return false }
        let port = live.port ?? (scheme == "https" ? 443 : 80)
        // WebKit reports zero when the origin has no explicit port.
        let originPort = origin.port == 0 ? (origin.protocol == "https" ? 443 : 80) : origin.port
        return origin.protocol == scheme && origin.host == host && originPort == port
    }
}

@MainActor
private final class ShellHostsBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: ShellViewController?
    func userContentController(
        _ controller: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard message.frameInfo.isMainFrame,
            ShellSource.trusts(message.frameInfo.securityOrigin) || message.frameInfo.request.url?.isFileURL == true,
            let body = message.body as? [String: Any], body["scope"] as? String == ShellSource.scope
        else {
            replyHandler(nil, "This connection has changed.")
            return
        }
        owner?.changeHost(body, reply: replyHandler)
    }
}

// Recognize modifier-button drags immediately; ordinary scrolling fails immediately as well,
// so a trackpad never has to travel through a pan threshold before the website can scroll.
@MainActor
private final class WindowDragGesture: UIGestureRecognizer {
    var permitted: (() -> Bool)?
    var changed: ((String, CGPoint, Int) -> Void)?
    weak var coordinateView: UIView?
    private var secondary = false
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .possible, touches.count == 1,
            let touch = touches.first, touch.type == .indirectPointer,
            event.modifierFlags.contains(.command), !event.buttonMask.isEmpty,
            permitted?() == true
        else {
            state = .failed
            return
        }
        secondary = event.buttonMask.contains(.secondary)
        state = .began
        changed?("begin", touch.location(in: coordinateView), secondary ? 2 : 0)
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .began || state == .changed, let touch = touches.first else { return }
        state = .changed
        changed?("move", touch.location(in: coordinateView), secondary ? 2 : 0)
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .began || state == .changed, let touch = touches.first else { return }
        changed?("end", touch.location(in: coordinateView), secondary ? 2 : 0)
        state = .ended
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .began || state == .changed else { return }
        changed?("cancel", .zero, 0)
        state = .cancelled
    }
}

@MainActor
private final class ShellWebView: WKWebView {
    // The shell supplies its own mode and dismissal controls above the keyboard.
    #if !os(visionOS)
        override var inputAccessoryView: UIView? { nil }
        override var inputAssistantItem: UITextInputAssistantItem {
            let item = super.inputAssistantItem
            if (traitCollection.userInterfaceIdiom == .pad || traitCollection.userInterfaceIdiom == .vision) {
                item.leadingBarButtonGroups = []
                item.trailingBarButtonGroups = []
            }
            return item
        }
    #endif
}

@MainActor
private final class ShellStorageBridge: NSObject, WKScriptMessageHandler {
    private var key: String { "omarchyShellStorage." + (ShellSource.liveURL?.absoluteString ?? "offline") }
    var snapshot: [String: String] { UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:] }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
            ShellSource.trusts(message.frameInfo.securityOrigin) || message.frameInfo.request.url?.isFileURL == true,
            let body = message.body as? [String: Any]
        else { return }
        save(body)
    }
    func save(_ body: [String: Any]) {
        guard body["scope"] as? String == ShellSource.scope, !ShellSource.scope.isEmpty,
            let values = body["values"] as? [String: String], values.count <= 128,
            values.allSatisfy({ $0.key.hasPrefix("omarchy-") && $0.key.count <= 100 && $0.value.utf8.count <= 262144 }),
            values.reduce(0, { $0 + $1.value.utf8.count }) <= 1048576
        else { return }
        UserDefaults.standard.set(values, forKey: key)
    }
}

@MainActor
private final class ShellKeyboardStateBridge: NSObject, WKScriptMessageHandler {
    weak var owner: ShellViewController?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
            ShellSource.trusts(message.frameInfo.securityOrigin) || message.frameInfo.request.url?.isFileURL == true
        else { return }
        if let editing = message.body as? Bool {
            owner?.updateKeyboardEditing(editing)
        } else if let body = message.body as? [String: Any], let commands = body["commands"] as? [[String: Any]] {
            owner?.updateCommands(commands)
        }
    }
}

@MainActor
private final class WeatherDeviceBridge: NSObject, WKScriptMessageHandlerWithReply,
    @preconcurrency CLLocationManagerDelegate
{
    private lazy var manager: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
        return manager
    }()
    private let geocoder = CLGeocoder()
    private var pending: (@MainActor @Sendable (Any?, String?) -> Void)?
    private var timeout: DispatchWorkItem?

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
            ShellSource.trusts(origin) || message.frameInfo.request.url?.isFileURL == true,
            let body = message.body as? [String: Any]
        else {
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
        let timer = DispatchWorkItem { [weak self] in
            self?.finish(nil, error: "Location timed out. Try again or choose a city.")
        }
        timeout = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: timer)
        if manager.authorizationStatus == .notDetermined {
            if body["requestPermission"] as? Bool == true {
                manager.requestWhenInUseAuthorization()
            } else {
                finish(nil, error: "Tap Use phone location to allow location access.")
            }
        } else {
            requestAuthorizedLocation()
        }
    }
    private func requestAuthorizedLocation() {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
        case .denied, .restricted:
            finish(nil, error: "Location access is off. Enable it in iOS Settings or choose a city.")
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
private final class BrowserDeviceBridge: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate,
    UIGestureRecognizerDelegate
{
    weak var presenter: UIViewController?
    weak var shell: WKWebView?
    private var page: WKWebView?
    private var appID: String?
    private var ownShortcutsActive = false {
        didSet { if ownShortcutsActive != oldValue { UIMenuSystem.main.setNeedsRebuild() } }
    }
    private var webApps: [String: BrowserDeviceBridge] = [:]
    private var isBrowser: Bool { appID == nil || appID?.hasPrefix("window-") == true }
    var shortcutsActive: Bool { ownShortcutsActive || webApps.values.contains { $0.shortcutsActive } }
    private var observations: [NSKeyValueObservation] = []
    private var pageOwnsKeyboardFocus: Bool {
        func containsResponder(_ view: UIView) -> Bool {
            view.isFirstResponder || view.subviews.contains(where: containsResponder)
        }
        return page.map(containsResponder) ?? false
    }
    var ownsKeyboardFocus: Bool {
        pageOwnsKeyboardFocus || webApps.values.contains { $0.ownsKeyboardFocus }
    }
    private var requestedFocus = false
    private func updateFocus(_ focused: Bool) {
        let gainingFocus = focused && !requestedFocus
        requestedFocus = focused
        guard let page else { return }
        if !focused {
            // Restrict resignation to this page, irrespective of sibling update order.
            if pageOwnsKeyboardFocus { page.endEditing(true) }
        } else if gainingFocus, GCKeyboard.coalesced != nil {
            // A layout animation must not repeatedly steal focus from page controls.
            page.becomeFirstResponder()
        }
    }
    private var requestedVisible = false
    private var controlsHidden = false
    private var forceDark = UserDefaults.standard.bool(forKey: "browserForceDark")
    private let darkWorld = WKContentWorld.world(name: "BrowserAppearance")
    private lazy var darkSource: String? = {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("Web/vendor/darkreader/darkreader.js") else {
            return nil
        }
        return try? String(contentsOf: url, encoding: .utf8)
    }()
    private func darkScript(_ enabled: Bool) -> String {
        guard let darkSource else { return "" }
        return "if (!globalThis.DarkReader) {\n" + darkSource + "\n}\n"
            + (enabled
                ? "DarkReader.setFetchMethod(window.fetch.bind(window)); DarkReader.enable({brightness:100,contrast:100,sepia:0}, {disableStyleSheetsProxy:true,disableCustomElementRegistryProxy:true});"
                : "DarkReader.disable();")
    }
    private func configureDarkScripts(_ browser: WKWebView) {
        let controller = browser.configuration.userContentController
        controller.removeAllUserScripts()
        if forceDark, darkSource != nil {
            controller.addUserScript(
                WKUserScript(
                    source: darkScript(true), injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: darkWorld))
        }
    }

    private var lastHoverLocation: CGPoint?
    private var panY: CGFloat = 0
    private var scrollTravel: CGFloat = 0

    func resetAll() {
        for app in webApps.values { app.reset() }
        webApps.removeAll()
        reset()
    }
    func reset() {
        lastHoverLocation = nil
        ownShortcutsActive = false
        updateFocus(false)
        observations.removeAll()
        page?.findInteraction?.dismissFindNavigator()
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
        browser.isFindInteractionEnabled = true
        browser.accessibilityIdentifier =
            appID.map { (isBrowser ? "hyprland.browser." : "hyprland.webapp.") + $0 } ?? "hyprland.browser.page"
        let focus = UITapGestureRecognizer()
        focus.delegate = self
        focus.cancelsTouchesInView = false
        focus.delaysTouchesBegan = false
        focus.delaysTouchesEnded = false
        browser.addGestureRecognizer(focus)
        #if !os(visionOS)
            // visionOS hover can represent gaze rather than intentional pointer movement.
            let hover = UIHoverGestureRecognizer(target: self, action: #selector(pageHovered(_:)))
            hover.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
            hover.cancelsTouchesInView = false
            hover.delaysTouchesBegan = false
            hover.delaysTouchesEnded = false
            hover.delegate = self
            browser.addGestureRecognizer(hover)
        #endif
        let drag = WindowDragGesture()
        drag.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        drag.delaysTouchesBegan = false
        drag.delaysTouchesEnded = false
        drag.coordinateView = shell
        drag.permitted = { [weak self] in
            guard let self, let shell = self.shell else { return false }
            #if os(visionOS)
                return self.requestedVisible
            #else
                return self.requestedVisible && min(shell.bounds.width, shell.bounds.height) >= 600
            #endif
        }
        drag.changed = { [weak self] phase, location, button in
            self?.shell?.callAsyncJavaScript(
                "window.HyprlandDesk?.nativePointer(event)",
                arguments: ["event": ["phase": phase, "x": location.x, "y": location.y, "button": button]],
                in: nil, in: .page, completionHandler: nil)
        }
        browser.addGestureRecognizer(drag)
        presenter.view.addSubview(browser)
        page = browser
        observations = [
            browser.observe(\.url, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.publish() } },
            browser.observe(\.isLoading, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.publish() }
            },
            browser.scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    guard let self, let page = self.page, !page.isHidden else { return }
                    if page.scrollView.contentOffset.y <= 0 { self.showControls(false) }
                }
            },
        ]
        return browser
    }
    private func showControls(_ hidden: Bool) {
        guard isBrowser, controlsHidden != hidden else { return }
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
        if page.scrollView.contentOffset.y <= 0 {
            showControls(false)
        } else if scrollTravel < -20 && page.scrollView.contentSize.height > page.bounds.height {
            showControls(true)
        }
    }
    @objc private func pageHovered(_ hover: UIHoverGestureRecognizer) {
        guard hover.state == .began || hover.state == .changed else {
            lastHoverLocation = nil
            return
        }
        guard let page, !page.isHidden, page.window != nil else { return }
        let location = hover.location(in: page)
        guard page.bounds.contains(location), lastHoverLocation != location else { return }
        lastHoverLocation = location
        // Only a hint: the shell owns the opt-in setting and overlay/workspace checks.
        publish(hovered: true)
    }
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        gestureRecognizer is UIHoverGestureRecognizer || otherGestureRecognizer is UIHoverGestureRecognizer
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive event: UIEvent) -> Bool {
        // Hover must not change window focus while a mouse button is held.
        if gestureRecognizer is UIHoverGestureRecognizer, !event.buttonMask.isEmpty { return false }
        // Focus observation must never participate in trackpad wheel recognition.
        return event.type != .scroll
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        if gestureRecognizer is UIHoverGestureRecognizer { return touch.type == .indirectPointer }
        guard let page, let touched = touch.view, touched === page || touched.isDescendant(of: page) else {
            return false
        }
        publish(focused: true)
        return false  // Observe focus without recognizing or cancelling website touches.
    }
    private func publish(
        error: String? = nil, preview: String? = nil, focused: Bool = false, hovered: Bool = false,
        controlsHidden: Bool? = nil
    ) {
        guard let page else { return }
        var state: [String: Any] = [
            "url": page.url?.absoluteString ?? "", "back": page.canGoBack, "forward": page.canGoForward,
            "loading": page.isLoading,
        ]
        if let appID { state["appID"] = appID }
        if let controlsHidden { state["controlsHidden"] = controlsHidden }
        if focused { state["focused"] = true }
        if hovered { state["hovered"] = true }
        if let error { state["error"] = error }
        if let preview { state["preview"] = preview }
        shell?.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent('host-browser-state', {detail: state}))", arguments: ["state": state],
            in: nil, in: .page, completionHandler: nil)
    }
    private func snapshot() {
        guard let page, !page.isHidden, !page.isLoading, !page.bounds.isEmpty else { return }
        let capturedURL = page.url
        let config = WKSnapshotConfiguration()
        config.snapshotWidth = 600
        page.takeSnapshot(with: config) { [weak self, weak page] image, _ in
            guard let self, let page, self.page === page, !page.isHidden, page.url == capturedURL,
                let data = image?.jpegData(compressionQuality: 0.65)
            else { return }
            self.publish(preview: "data:image/jpeg;base64," + data.base64EncodedString())
        }
    }
    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard message.webView === shell, message.frameInfo.isMainFrame,
            ShellSource.trusts(message.frameInfo.securityOrigin) || message.frameInfo.request.url?.isFileURL == true,
            let body = message.body as? [String: Any]
        else { replyHandler(nil, "Unsupported page"); return }
        let action = body["action"] as? String ?? "open"
        if appID == nil, let id = body["appID"] as? String {
            guard (id.hasPrefix("webapp-") || id.hasPrefix("window-")), id.count <= 80,
                id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") })
            else { replyHandler(nil, "Invalid web app"); return }
            if webApps[id] == nil {
                if action == "close" || action == "layout" { replyHandler(["visible": false], nil); return }
                guard webApps.count < 10 else { replyHandler(nil, "Close a web app first"); return }
                let app = BrowserDeviceBridge()
                app.appID = id
                app.presenter = presenter
                app.shell = shell
                webApps[id] = app
            }
            webApps[id]?.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
            if action == "close" { webApps.removeValue(forKey: id) }
            return
        }
        if action == "capabilities" {
            replyHandler(
                [
                    "nativeFind": true, "shortcuts": true, "embedded": true, "webApps": true, "browserWindows": true,
                    "darkMode": darkSource != nil, "dark": forceDark,
                ], nil);
            return
        }
        if action == "context" {
            guard isBrowser else { replyHandler(nil, "Browser context only"); return }
            ownShortcutsActive = body["active"] as? Bool == true
            replyHandler(["active": shortcutsActive], nil)
            return
        }
        if action == "close" { reset(); replyHandler(["closed": true], nil); return }
        if action == "layout" {
            guard let page, let presenter else { replyHandler(["visible": false], nil); return }
            let visible = body["visible"] as? Bool == true
            if !visible {
                lastHoverLocation = nil
                page.findInteraction?.dismissFindNavigator()
                requestedVisible = false
                updateFocus(false)
                page.isHidden = true
                replyHandler(["visible": false], nil)
                return
            }
            guard let rect = body["rect"] as? [Double], rect.count == 4, rect.allSatisfy({ $0.isFinite }),
                let viewport = body["viewport"] as? Double, viewport.isFinite, viewport > 0,
                rect[2] > 0, rect[3] > 0
            else {
                requestedVisible = false; updateFocus(false); page.isHidden = true; replyHandler(nil, "Invalid bounds");
                return
            }
            let scale = presenter.view.bounds.width / viewport
            // Keep WebKit's viewport intact while a workspace slides partly offscreen.
            // Intersect only for visibility: resizing to the visible slice reflows the page.
            let frame = CGRect(x: rect[0] * scale, y: rect[1] * scale, width: rect[2] * scale, height: rect[3] * scale)
            let visibleFrame = frame.intersection(presenter.view.bounds)
            if let hidden = body["controlsHidden"] as? Bool { controlsHidden = hidden }
            if let opacity = body["opacity"] as? Double, opacity.isFinite { page.alpha = max(0.5, min(1, opacity)) }
            page.frame = frame
            if let radius = body["radius"] as? Double, radius.isFinite {
                page.layer.cornerRadius = max(0, min(min(frame.width, frame.height) / 2, radius * scale))
            }
            page.layer.maskedCorners =
                body["roundedTop"] as? Bool == true
                ? [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
                : [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
            requestedVisible = !visibleFrame.isEmpty && !visibleFrame.isNull
            page.isHidden = !requestedVisible
            updateFocus(requestedVisible && body["focused"] as? Bool == true)
            if let rgb = body["background"] as? [Double], rgb.count == 3,
                rgb.allSatisfy({ $0.isFinite && (0...255).contains($0) })
            {
                let color = UIColor(red: rgb[0] / 255, green: rgb[1] / 255, blue: rgb[2] / 255, alpha: 1)
                page.underPageBackgroundColor = color
                page.backgroundColor = color
            }
            replyHandler(["visible": requestedVisible], nil)
            return
        }
        guard let page = ensurePage() else { replyHandler(nil, "Browser unavailable"); return }
        switch action {
        case "open":
            guard let raw = body["url"] as? String, let url = URL(string: raw),
                ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil
            else { replyHandler(nil, "Use an http or https URL"); return }
            page.findInteraction?.dismissFindNavigator()
            page.load(URLRequest(url: url))
        case "dark":
            guard let enabled = body["enabled"] as? Bool, darkSource != nil else {
                replyHandler(nil, "Dark mode unavailable"); return
            }
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
        case "reload":
            if body["bypassCache"] as? Bool == true { page.reloadFromOrigin() } else { page.reload() }
        case "stop": page.stopLoading()
        case "focus":
            if body["active"] as? Bool == false {
                if pageOwnsKeyboardFocus { page.endEditing(true) }
                shell?.becomeFirstResponder()
            } else {
                page.becomeFirstResponder()
            }
        case "zoom":
            guard let value = body["value"] as? Double, value.isFinite else {
                replyHandler(nil, "Invalid zoom"); return
            }
            page.pageZoom = max(0.25, min(5, value))
            replyHandler(["zoom": page.pageZoom], nil)
            return
        case "findOpen":
            page.becomeFirstResponder()
            page.findInteraction?.presentFindNavigator(showingReplace: false)
        case "findNext":
            if page.findInteraction?.isFindNavigatorVisible != true {
                page.findInteraction?.presentFindNavigator(showingReplace: false)
            } else if body["backwards"] as? Bool == true {
                page.findInteraction?.findPrevious()
            } else {
                page.findInteraction?.findNext()
            }
        case "findClose":
            let closed = page.findInteraction?.isFindNavigatorVisible == true
            page.findInteraction?.dismissFindNavigator()
            replyHandler(["closed": closed], nil)
            return
        default: replyHandler(nil, "Unknown browser action"); return
        }
        replyHandler(["opened": true], nil)
    }
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? ""
        let isWebLink = ["http", "https"].contains(scheme)
        // Saved apps have one browsing context. Own tapped top-level links and popup
        // requests here, loading them programmatically instead of handing them off.
        // The resulting .other navigation is allowed, preserving back/forward history.
        if appID != nil, isWebLink,
            navigationAction.targetFrame == nil
                || (navigationAction.targetFrame?.isMainFrame == true
                    && navigationAction.navigationType == .linkActivated)
        {
            decisionHandler(.cancel)
            webView.load(navigationAction.request)
            return
        }
        let allowed = isWebLink || scheme == "about"
        if !allowed { publish(error: "This link requires an external app.") }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            webView.load(navigationAction.request)
        }
        return nil
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        controlsHidden = false; publish(controlsHidden: false)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { publish(); snapshot() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { publish(error: error.localizedDescription) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { publish(error: error.localizedDescription) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        publish(error: "Page stopped. Tap Reload to restore it.")
    }
}

@MainActor
final class ShellViewController: UIViewController, WKNavigationDelegate {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "OmarchyRemote", category: "Shell")
    private let background = UIColor(red: 25 / 255, green: 23 / 255, blue: 36 / 255, alpha: 1)
    private var webView: WKWebView!
    private let weatherDevice = WeatherDeviceBridge()
    private let browserDevice = BrowserDeviceBridge()
    private let keyboardState = ShellKeyboardStateBridge()
    private let storageBridge = ShellStorageBridge()
    private let hostsBridge = ShellHostsBridge()
    private var showingHosts = false
    private var shellBottom: NSLayoutConstraint?
    private var pickerBottom: NSLayoutConstraint?
    private var shellEditing = false
    private var lastKeyboardGeometry: [Double]?
    private let keyboardProbe = UIView()
    private var webRoot: URL?
    private let retryButton = UIButton(type: .system)
    private let sourceButton = UIButton(type: .system)
    private var remoteNavigation: WKNavigation?
    private var loadGeneration = 0
    private var loadTimeout: DispatchWorkItem?
    private var usingOfflineFallback = false
    private var contentNeedsRecovery = false
    private var recoveryAttempts: [Date] = []
    private var reconnectTask: Task<Void, Never>?
    private var developmentURL: URL? { ShellSource.liveURL }
    private var prefersBundle: Bool {
        UserDefaults.standard.bool(forKey: "useBundledPrototype")
            || ProcessInfo.processInfo.arguments.contains("--bundled")
    }

    // Register shell actions with UIKit: DOM keydown alone loses commands to iPadOS.
    // Only claim arrows outside text fields; clipboard and OS launcher keys stay native.
    override var keyCommands: [UIKeyCommand]? {
        guard
            traitCollection.userInterfaceIdiom == .pad || traitCollection.userInterfaceIdiom == .vision
                || (browserDevice.shortcutsActive && GCKeyboard.coalesced != nil)
        else { return super.keyCommands }
        var used = Set<String>()
        return registeredCommands.flatMap { row -> [UIKeyCommand] in
            guard let code = row["code"] as? String, let title = row["label"] as? String else { return [] }
            if row["editing"] as? Bool == true && (shellEditing || browserDevice.ownsKeyboardFocus) { return [] }
            let special: [String: String] = [
                "ArrowLeft": UIKeyCommand.inputLeftArrow, "ArrowRight": UIKeyCommand.inputRightArrow,
                "ArrowUp": UIKeyCommand.inputUpArrow, "ArrowDown": UIKeyCommand.inputDownArrow,
                "PageUp": UIKeyCommand.inputPageUp, "PageDown": UIKeyCommand.inputPageDown,
                "Escape": UIKeyCommand.inputEscape, "Tab": "\t", "Enter": "\r", "NumpadEnter": "\r",
                "Backspace": "\u{8}", "BracketLeft": "[", "BracketRight": "]", "Slash": "/", "Comma": ",",
                "Equal": "=", "Minus": "-", "NumpadAdd": "+", "NumpadSubtract": "-",
                "Space": " ", "Period": ".", "Semicolon": ";", "Quote": "'", "Backquote": "`", "Backslash": "\\",
                "F2": UIKeyCommand.f2, "F3": UIKeyCommand.f3, "F5": UIKeyCommand.f5,
            ]
            let input: String
            if let value = special[code] {
                input = value
            } else if code.hasPrefix("Key") {
                input = String(code.dropFirst(3)).lowercased()
            } else if code.hasPrefix("Digit") {
                input = String(code.dropFirst(5))
            } else {
                return []
            }
            var flags: UIKeyModifierFlags = []
            if row["meta"] as? Bool == true { flags.insert(.command) }
            if row["ctrl"] as? Bool == true { flags.insert(.control) }
            if row["alt"] as? Bool == true { flags.insert(.alternate) }
            if row["shift"] as? Bool == true { flags.insert(.shift) }
            var inputs = [input]
            if flags.contains(.shift) {
                if code == "BracketLeft" { inputs.append("{") }
                if code == "BracketRight" { inputs.append("}") }
                if code == "Equal" { inputs.append("+") }
                let shifted = [
                    "Period": ">", "Comma": "<", "Slash": "?", "Semicolon": ":", "Quote": "\"", "Backquote": "~",
                    "Backslash": "|", "Minus": "_",
                ]
                if let character = shifted[code] { inputs.append(character) }
            }
            return inputs.compactMap { candidate in
                let identity = "\(candidate):\(flags.rawValue)"
                guard used.insert(identity).inserted else { return nil }
                let command = UIKeyCommand(
                    title: title, action: #selector(handleShellKey(_:)), input: candidate, modifierFlags: flags,
                    propertyList: [
                        "code": code, "shift": flags.contains(.shift), "alt": flags.contains(.alternate),
                        "ctrl": flags.contains(.control),
                        "meta": flags.contains(.command),
                        "plain": !flags.contains(.command) && !flags.contains(.control),
                        "focusShell": row["focusShell"] as? Bool == true,
                    ])
                command.wantsPriorityOverSystemBehavior = true
                return command
            }
        }
    }

    private var registeredCommands: [[String: Any]] = []
    fileprivate func updateCommands(_ commands: [[String: Any]]) {
        guard commands.count <= 256,
            commands.allSatisfy({ row in
                guard let code = row["code"] as? String, let label = row["label"] as? String else { return false }
                return code.count <= 32 && label.count <= 160
            })
        else { return }
        registeredCommands = commands
        UIMenuSystem.main.setNeedsRebuild()
    }

    fileprivate func updateKeyboardEditing(_ editing: Bool) {
        guard editing != shellEditing else { return }
        shellEditing = editing
        // Picker shortcuts do not depend on text editing.
        if !showingHosts { UIMenuSystem.main.setNeedsRebuild() }
    }

    @objc private func handleShellKey(_ command: UIKeyCommand) {
        guard let payload = command.propertyList as? [String: Any], let webView else { return }
        if payload["focusShell"] as? Bool == true {
            webView.becomeFirstResponder()
        }
        webView.callAsyncJavaScript(
            "return window.HyprlandDesk?.nativeKey(key);",
            arguments: ["key": payload], in: nil, in: .page, completionHandler: nil)
    }

    #if !os(visionOS)
        override var prefersStatusBarHidden: Bool { true }
        override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { [.top, .bottom] }
        // Keep the system's dimmed escape indicator when bottom-edge deferral is active.
        override var prefersHomeIndicatorAutoHidden: Bool { false }
        // iPhone keeps the portrait phone shell; iPad rotates freely and the web shell relays out in desk mode.
        override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
            (traitCollection.userInterfaceIdiom == .pad || traitCollection.userInterfaceIdiom == .vision)
                ? .all : .portrait
        }

    #endif

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = background
        for name in [
            Notification.Name.GCKeyboardDidConnect, .GCKeyboardDidDisconnect, UIApplication.didBecomeActiveNotification,
        ] {
            NotificationCenter.default.addObserver(
                self, selector: #selector(publishHardwareKeyboard), name: name, object: nil)
        }

        let configuration = WKWebViewConfiguration()
        #if os(visionOS)
            configuration.userContentController.addUserScript(
                WKUserScript(
                    source: "window.__OMARCHY_PLATFORM__ = 'visionos';",
                    injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
        #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--browser-shortcuts-test"), prefersBundle {
                // Isolated XCTest fixture: no browser actions or other API calls reach the host.
                configuration.userContentController.addUserScript(
                    WKUserScript(
                        source: """
                            let fixtureUtil;
                            Object.defineProperty(window, 'HyprlandUtil', {configurable:true,
                                get:()=>fixtureUtil, set:value=>{fixtureUtil=value;
                                    value.storage.set('omarchy-layout-desk', null);
                                    value.storage.set('omarchy-layout-phone', null);
                                }});
                            let fixtureApps;
                            Object.defineProperty(window, 'HyprlandApps', {configurable:true,
                                get:()=>fixtureApps, set:value=>{fixtureApps=value; value.catalog.browser.offline=true;}});
                            const browserFixture = {instances:[{id:'qa',label:'QA Browser',workspace_write:true,workspaces:[],windows:[{id:1,focused:true,tabs:[
                                {id:10,title:'Example Domain',url:'https://example.com/',index:0,active:true},
                                {id:11,title:'Other Example',url:'https://example.org/',index:1,active:false}
                            ]}]}]};
                            const originalFetch = window.fetch.bind(window);
                            window.fetch = async (url, options) => {
                                const path = String(url);
                                if (path === '/api/browser/snapshot') return new Response(JSON.stringify(browserFixture), {status:200});
                                if (path === '/api/browser/action') return new Response(JSON.stringify({ok:true}), {status:200});
                                if (path.startsWith('/api/')) return new Response('{}', {status:503});
                                return originalFetch(url, options);
                            };
                            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            }
        #endif
        // Keep shell preferences on disk, separate from embedded websites and their logins.
        configuration.websiteDataStore = WKWebsiteDataStore(
            forIdentifier: UUID(uuidString: "D4D78234-4474-4CD8-9D29-C9F226134F66")!)
        configuration.userContentController.add(storageBridge, name: "shellStorage")
        hostsBridge.owner = self
        configuration.userContentController.addScriptMessageHandler(
            hostsBridge, contentWorld: .page, name: "shellHosts")
        refreshDeviceIdentity(in: configuration.userContentController)
        keyboardState.owner = self
        configuration.userContentController.add(keyboardState, name: "shellKeyboard")
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: """
                    (() => {
                        const report = () => {
                            const el = document.activeElement;
                            const editing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
                            window.webkit.messageHandlers.shellKeyboard.postMessage(editing);
                        };
                        document.addEventListener('focusin', report, true);
                        document.addEventListener('focusout', () => queueMicrotask(report), true);
                        document.addEventListener('DOMContentLoaded', report);
                    })();
                    """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        browserDevice.presenter = self
        configuration.userContentController.addScriptMessageHandler(
            browserDevice, contentWorld: .page, name: "browserDevice")
        configuration.userContentController.addScriptMessageHandler(
            weatherDevice, contentWorld: .page, name: "weatherDevice")
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
        if (traitCollection.userInterfaceIdiom == .pad || traitCollection.userInterfaceIdiom == .vision) {
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
                keyboardProbe.heightAnchor.constraint(equalToConstant: 0),
            ])
        }
        // The connection form follows the keyboard; the full-screen shell owns its own geometry.
        shellBottom = webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        pickerBottom = webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        shellBottom?.isActive = true
        // Deliberately use the view edges, not the safe-area guide.
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        retryButton.setTitle("Couldn’t open Omarchy Remote. Tap to retry.", for: .normal)
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
            retryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
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
            sourceButton.heightAnchor.constraint(equalToConstant: 44),
        ])
        if developmentURL != nil {
            let sourceGesture = UILongPressGestureRecognizer(target: self, action: #selector(showSourceMenu(_:)))
            // This debug shortcut is for two fingers on the touchscreen, never a trackpad.
            sourceGesture.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
            sourceGesture.delaysTouchesBegan = false
            sourceGesture.delaysTouchesEnded = false
            sourceGesture.numberOfTouchesRequired = 2
            sourceGesture.minimumPressDuration = 0.8
            sourceGesture.cancelsTouchesInView = false
            view.addGestureRecognizer(sourceGesture)
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(resumeLive), name: UIApplication.didBecomeActiveNotification, object: nil)
        #if !os(visionOS)
            UIDevice.current.isBatteryMonitoringEnabled = true
            for name in [
                UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification,
                UIApplication.didBecomeActiveNotification,
            ] {
                NotificationCenter.default.addObserver(
                    self, selector: #selector(publishBattery), name: name, object: nil)
            }
        #endif
        loadShell()
    }

    @objc private func publishBattery() {
        guard let webView else { return }
        #if !os(visionOS)
            let device = UIDevice.current
            let state: String
            switch device.batteryState {
            case .charging: state = "charging"
            case .full: state = "full"
            case .unplugged: state = "unplugged"
            default: state = "unknown"
            }
            var battery: [String: Any] = ["percent": NSNull(), "state": state]
            if device.batteryLevel >= 0 {
                battery["percent"] = Int((device.batteryLevel * 100).rounded())
            }
        #else
            let battery: [String: Any] = ["percent": NSNull(), "state": "unknown"]
        #endif
        webView.callAsyncJavaScript(
            "window.__HYPRLAND_BATTERY__ = battery; window.dispatchEvent(new Event('hyprland-battery'));",
            arguments: ["battery": battery], in: nil, in: .page, completionHandler: nil)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        publishKeyboardGeometry()
    }

    @objc private func publishHardwareKeyboard() {
        webView?.callAsyncJavaScript(
            "window.__HYPRLAND_HARDWARE_KEYBOARD__ = connected; window.dispatchEvent(new Event('hyprland-hardware-keyboard'));",
            arguments: ["connected": GCKeyboard.coalesced != nil], in: nil, in: .page, completionHandler: nil)
    }

    private func publishKeyboardGeometry(force: Bool = false) {
        guard (traitCollection.userInterfaceIdiom == .pad || traitCollection.userInterfaceIdiom == .vision),
            let webView, view.bounds.height > 0
        else { return }
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
        #if !os(visionOS)
            setNeedsStatusBarAppearanceUpdate()
        #endif
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
    }

    private var deviceIdentityScript: WKUserScript?
    private func refreshDeviceIdentity(in controller: WKUserContentController) {
        let identityKey = "omarchyDeviceIdentifier"
        let deviceID = UserDefaults.standard.string(forKey: identityKey) ?? UUID().uuidString.lowercased()
        UserDefaults.standard.set(deviceID, forKey: identityKey)
        let identity: [String: Any] = [
            "id": deviceID, "name": UIDevice.current.model, "snapshot": storageBridge.snapshot,
            "scope": ShellSource.scope, "hosts": ShellSource.directory,
            "legacyScope": ShellSource.normalize(
                Bundle.main.object(forInfoDictionaryKey: "OmarchyRemoteURL") as? String ?? "")?.absoluteString ?? "",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: identity),
            let json = String(data: data, encoding: .utf8)
        else { return }
        let remaining = controller.userScripts.filter { $0 !== deviceIdentityScript }
        controller.removeAllUserScripts()
        let script = WKUserScript(
            source: "window.__OMARCHY_DEVICE__ = " + json + ";",
            injectionTime: .atDocumentStart, forMainFrameOnly: true)
        deviceIdentityScript = script
        controller.addUserScript(script)
        for existing in remaining { controller.addUserScript(existing) }
    }

    @objc private func loadShell() {
        pickerBottom?.isActive = false
        shellBottom?.isActive = true
        webView.scrollView.isScrollEnabled = false
        refreshDeviceIdentity(in: webView.configuration.userContentController)
        reconnectTask?.cancel()
        reconnectTask = nil
        contentNeedsRecovery = false
        loadGeneration += 1
        loadTimeout?.cancel()
        remoteNavigation = nil
        usingOfflineFallback = false
        sourceButton.isHidden = true
        retryButton.isHidden = true
        if showingHosts || ShellSource.liveURL == nil {
            loadHostPicker()
        } else if let url = developmentURL, !prefersBundle {
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

    fileprivate func changeHost(_ body: [String: Any], reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        storageBridge.save(body)
        var directory = ShellSource.directory
        var hosts = directory["hosts"] as? [[String: String]] ?? []
        let action = body["action"] as? String ?? ""
        let id = body["id"] as? String ?? ""
        switch action {
        case "prompt":
            guard presentedViewController == nil else {
                reply(nil, "Finish the open dialog first.")
                return
            }
            let alert = UIAlertController(
                title: "Add Host", message: "Enter the machine’s HTTPS address.", preferredStyle: .alert)
            alert.addTextField { field in
                field.placeholder = "Name (optional)"
                field.accessibilityLabel = "Name"
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.clearButtonMode = .whileEditing
            }
            alert.addTextField { field in
                field.placeholder = "https://machine.tailnet.ts.net"
                field.accessibilityLabel = "Address"
                field.keyboardType = .URL
                field.textContentType = .URL
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.clearButtonMode = .whileEditing
            }
            let save = UIAlertAction(title: "Save", style: .default) { [weak self, weak alert] _ in
                guard let self, let fields = alert?.textFields else {
                    reply(nil, "The dialog closed.")
                    return
                }
                self.changeHost(
                    ["action": "save", "name": fields[0].text ?? "", "url": fields[1].text ?? ""], reply: reply)
            }
            save.isEnabled = false
            alert.textFields?[1].addAction(
                UIAction { [weak alert, weak save] _ in
                    save?.isEnabled = ShellSource.normalize(alert?.textFields?[1].text ?? "") != nil
                }, for: .editingChanged)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in reply(ShellSource.directory, nil) })
            alert.addAction(save)
            alert.preferredAction = save
            present(alert, animated: true)
            return
        case "save":
            guard let raw = body["url"] as? String, let url = ShellSource.normalize(raw) else {
                reply(nil, "Use the host’s HTTPS address.")
                return
            }
            let existing = hosts.firstIndex(where: { $0["url"] == url.absoluteString })
            guard existing != nil || hosts.count < 10 else {
                reply(nil, "You can save up to 10 hosts.")
                return
            }
            let name = String(
                (body["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
            let item = [
                "id": url.absoluteString, "url": url.absoluteString, "name": name.isEmpty ? (url.host ?? "Host") : name,
            ]
            if let existing {
                hosts[existing] = item
            } else {
                hosts.append(item)
            }
            directory["hosts"] = hosts
        case "remove":
            directory["hosts"] = hosts.filter { $0["id"] != id }
            if directory["selected"] as? String == id { directory["selected"] = "" }
        case "connect":
            guard hosts.contains(where: { $0["id"] == id }) else {
                reply(nil, "Host not found.")
                return
            }
            directory["selected"] = id
            showingHosts = false
            UserDefaults.standard.set(false, forKey: "useBundledPrototype")
        case "disconnect":
            directory["selected"] = ""
            showingHosts = true
        case "manage":
            showingHosts = true
        default:
            reply(nil, "Unknown host action.")
            return
        }
        ShellSource.directory = directory
        reply(directory, nil)
        if ["connect", "disconnect", "manage"].contains(action)
            || (action == "remove" && id == body["scope"] as? String)
        {
            browserDevice.resetAll()
            shellEditing = false
            updateCommands([])
            loadShell()
        }
    }

    private func loadHostPicker() {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true) else { return }
        showingHosts = true
        shellBottom?.isActive = false
        pickerBottom?.isActive = true
        webView.scrollView.isScrollEnabled = true
        webRoot = root
        refreshDeviceIdentity(in: webView.configuration.userContentController)
        webView.loadFileURL(root.appendingPathComponent("hosts.html"), allowingReadAccessTo: root)
    }

    private func loadBundledShell() {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true),
            FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path)
        else {
            retryButton.isHidden = false
            logger.error("Bundled Web/index.html is missing")
            return
        }
        webRoot = root
        refreshDeviceIdentity(in: webView.configuration.userContentController)
        retryButton.isHidden = true
        webView.loadFileURL(root.appendingPathComponent("index.html"), allowingReadAccessTo: root)
    }

    private func fallBackToBundle() {
        guard !usingOfflineFallback, !prefersBundle, developmentURL != nil, !showingHosts else { return }
        loadGeneration += 1
        loadTimeout?.cancel()
        remoteNavigation = nil
        webView.stopLoading()
        usingOfflineFallback = true
        sourceButton.isHidden = false
        logger.notice("Live shell unavailable; using bundled copy")
        loadBundledShell()
        scheduleLiveReconnect()
    }

    @objc private func retryLive() {
        UserDefaults.standard.set(false, forKey: "useBundledPrototype")
        loadShell()
    }

    @objc private func resumeLive() {
        if contentNeedsRecovery || !retryButton.isHidden {
            recoverContent()
        } else if usingOfflineFallback && !prefersBundle {
            loadShell()
        }
    }

    private func recoverContent() {
        guard UIApplication.shared.applicationState == .active else {
            contentNeedsRecovery = true
            return
        }
        let now = Date()
        recoveryAttempts = recoveryAttempts.filter { now.timeIntervalSince($0) < 60 }
        guard recoveryAttempts.count < 3 else {
            contentNeedsRecovery = false
            retryButton.isHidden = false
            return
        }
        recoveryAttempts.append(now)
        logger.notice("Recovering web content automatically")
        loadShell()
    }

    // Probe without replacing the usable offline page on every failed attempt.
    private func scheduleLiveReconnect() {
        reconnectTask?.cancel()
        guard let url = developmentURL, !prefersBundle, !showingHosts else { return }
        reconnectTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard let self, self.usingOfflineFallback, !self.prefersBundle else { return }
                guard UIApplication.shared.applicationState == .active else { continue }
                let generation = self.loadGeneration
                var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
                request.httpMethod = "HEAD"
                do {
                    let (_, response) = try await URLSession.shared.data(for: request)
                    guard !Task.isCancelled, self.loadGeneration == generation else { return }
                    guard UIApplication.shared.applicationState == .active else { continue }
                    if (response as? HTTPURLResponse)?.statusCode == 200 {
                        self.loadShell()
                        return
                    }
                } catch { /* Keep the local shell usable until the host returns. */  }
            }
        }
    }

    @objc private func showSourceMenu(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, presentedViewController == nil else { return }
        let menu = UIAlertController(
            title: "Prototype source",
            message:
                "Live mode loads the shell from \(ShellSource.hostLabel) and reloads when its files change. Connect to that host's network (for example Tailscale) to use it.",
            preferredStyle: .actionSheet)
        menu.addAction(
            UIAlertAction(title: "Live from \(ShellSource.hostLabel)", style: .default) { [weak self] _ in
                self?.retryLive()
            })
        menu.addAction(
            UIAlertAction(title: "Bundled offline copy", style: .default) { [weak self] _ in
                UserDefaults.standard.set(true, forKey: "useBundledPrototype")
                self?.loadShell()
            })
        menu.addAction(UIAlertAction(title: "Reload", style: .default) { [weak self] _ in self?.loadShell() })
        menu.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        present(menu, animated: true)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        browserDevice.resetAll()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryButton.isHidden = true
        publishKeyboardGeometry(force: true)
        publishHardwareKeyboard()
        publishBattery()
        if webView.url?.isFileURL == true {
            loadTimeout?.cancel()
            remoteNavigation = nil
            logger.info("Loaded Omarchy Remote shell: bundled")
        } else if !usingOfflineFallback {
            verifyLiveShell(generation: loadGeneration, attemptsRemaining: 12)
        }
    }

    // A completed HTTP navigation can still be a proxy error or a JS boot failure.
    // Only call the live source ready once the rendered shell actually exists.
    private func verifyLiveShell(generation: Int, attemptsRemaining: Int) {
        webView.evaluateJavaScript(
            "Boolean(document.querySelector('#touch-shell') && !document.querySelector('#touch-shell').closest('x-dc'))"
        ) { [weak self] result, _ in
            guard let self, self.loadGeneration == generation, !self.usingOfflineFallback else { return }
            if result as? Bool == true {
                self.loadTimeout?.cancel()
                self.remoteNavigation = nil
                self.logger.info("Loaded Omarchy Remote shell: live from \(ShellSource.hostLabel) (rendered)")
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
        logger.error("Web content process terminated; recovering")
        contentNeedsRecovery = true
        recoverContent()
    }

    private func showLoadFailure(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        logger.error("Shell load failed: \(error.localizedDescription, privacy: .public)")
        if remoteNavigation != nil || (webView.url?.scheme == "https" && !usingOfflineFallback) {
            fallBackToBundle(); return
        }
        retryButton.isHidden = false
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if let live = developmentURL,
            url.scheme == live.scheme, url.host == live.host,
            (url.port ?? (url.scheme == "https" ? 443 : 80)) == (live.port ?? (live.scheme == "https" ? 443 : 80))
        {
            decisionHandler(.allow)
        } else if url.isFileURL, let root = webRoot,
            url.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/")
        {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated,
                ["https", "http"].contains(url.scheme?.lowercased() ?? "")
            {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.isForMainFrame,
            let response = navigationResponse.response as? HTTPURLResponse,
            !(200..<300).contains(response.statusCode)
        {
            logger.error("Live server returned HTTP \(response.statusCode)")
            decisionHandler(.cancel)
            fallBackToBundle()
        } else {
            decisionHandler(.allow)
        }
    }
}
