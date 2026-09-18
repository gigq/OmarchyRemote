import UIKit

@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = ShellViewController()
        window.overrideUserInterfaceStyle = .dark
        self.window = window
        window.makeKeyAndVisible()
        #if os(visionOS)
            windowScene.requestGeometryUpdate(
                .Vision(
                    size: CGSize(width: 1280, height: 900),
                    minimumSize: CGSize(width: 600, height: 400),
                    resizingRestrictions: .freeform))
        #endif
    }
}
