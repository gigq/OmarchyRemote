import UIKit
import WebKit
import OSLog

@MainActor
private final class ShellWebView: WKWebView {
    // The shell supplies its own mode and dismissal controls above the keyboard.
    override var inputAccessoryView: UIView? { nil }
}

@MainActor
final class ShellViewController: UIViewController, WKNavigationDelegate {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "HyprlandTouch", category: "Shell")
    private let background = UIColor(red: 25 / 255, green: 23 / 255, blue: 36 / 255, alpha: 1)
    private var webView: WKWebView!
    private var webRoot: URL?
    private let retryButton = UIButton(type: .system)
    private let sourceButton = UIButton(type: .system)
    private var remoteNavigation: WKNavigation?
    private var loadGeneration = 0
    private var loadTimeout: DispatchWorkItem?
    private var usingOfflineFallback = false
    private var developmentURL: URL? {
        #if DEBUG
        URL(string: "https://your-host.your-tailnet.ts.net:12443/native/")
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
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = background

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
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
        sourceButton.setTitle("Offline copy · Retry HOST", for: .normal)
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
        logger.notice("HOST unavailable; using bundled prototype")
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
        let menu = UIAlertController(title: "Prototype source", message: "Live mode reloads when files change on HOST. Connect Tailscale on your iPhone to use it.", preferredStyle: .actionSheet)
        menu.addAction(UIAlertAction(title: "Live from HOST", style: .default) { [weak self] _ in self?.retryLive() })
        menu.addAction(UIAlertAction(title: "Bundled offline copy", style: .default) { [weak self] _ in
            UserDefaults.standard.set(true, forKey: "useBundledPrototype")
            self?.loadShell()
        })
        menu.addAction(UIAlertAction(title: "Reload", style: .default) { [weak self] _ in self?.loadShell() })
        menu.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        present(menu, animated: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryButton.isHidden = true
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
                self.logger.info("Loaded Hyprland shell: live from HOST (rendered)")
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
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
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

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
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
