import CarPlay
import UIKit

/// Scene delegate named in `UIApplicationSceneManifest` (see plugins/withCarPlay.js).
///
/// `@objc` gives it a flat Objective-C runtime name, so the Info.plist entry
/// stays `LumenCarPlaySceneDelegate` rather than a module-qualified Swift name
/// that changes with how the pod is built.
@objc(LumenCarPlaySceneDelegate)
public final class LumenCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    CarPlaySceneManager.shared.connect(interfaceController: interfaceController)
  }

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    CarPlaySceneManager.shared.disconnect()
  }
}
