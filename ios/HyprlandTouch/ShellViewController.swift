import UIKit
import WebKit
import OSLog

@MainActor
final class ShellViewController: UIViewController, WKNavigationDelegate {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "HyprlandTouch", category: "Shell")
    private let background = UIColor(red: 25 / 255, green: 23 / 255, blue: 36 / 255, alpha: 1)
    private var webView: WKWebView!
    private var webRoot: URL?
    private let retryButton = UIButton(type: .system)

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
        webView = WKWebView(frame: .zero, configuration: configuration)
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
        loadShell()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        setNeedsStatusBarAppearanceUpdate()
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
    }

    @objc private func loadShell() {
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryButton.isHidden = true
        logger.info("Loaded bundled Hyprland shell with status bar hidden and top/bottom gesture deferral")
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
        retryButton.isHidden = false
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.isFileURL, let root = webRoot,
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
}
