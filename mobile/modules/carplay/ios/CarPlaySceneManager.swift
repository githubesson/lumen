import CarPlay
import UIKit

/// Owns the CarPlay interface controller for as long as the car scene lives.
///
/// The car scene connects on its own schedule: while the phone app is
/// backgrounded, or — when the user taps Lumen on the car's home screen —
/// before React Native exists at all. So the scene delegate only ever talks to
/// this singleton. It holds the controller, puts a placeholder on screen so the
/// head unit is never blank, and replays the connection to whichever module
/// instance is attached once a JS runtime shows up.
final class CarPlaySceneManager {
  static let shared = CarPlaySceneManager()

  /// Long enough for an OTA or development manifest request, but bounded so a
  /// missing bundle never leaves the car's spinner up for the whole drive.
  private let bootstrapTimeout: TimeInterval = 20

  private(set) var interfaceController: CPInterfaceController?

  /// Set by `CarPlayModule` while a JS runtime is alive, cleared on teardown so
  /// a reloaded runtime never inherits the previous one's callbacks.
  var onConnect: (() -> Void)?
  var onDisconnect: (() -> Void)?

  var isConnected: Bool {
    interfaceController != nil
  }

  /// Scale of the car screen, which is its own display and rarely matches the
  /// phone's. Artwork is rendered at this scale so covers land crisp rather
  /// than resampled. Falls back to the common 2x when no car is attached.
  var displayScale: CGFloat {
    interfaceController?.carTraitCollection.displayScale ?? 2
  }

  private var bootstrapDeadline: DispatchWorkItem?

  func connect(interfaceController: CPInterfaceController) {
    NSLog("LUMENCP: connect, hasOnConnect=\(onConnect != nil)")
    self.interfaceController = interfaceController
    showPlaceholder()
    beginBootstrapDeadline()
    onConnect?()
  }

  func disconnect() {
    NSLog("LUMENCP: disconnect")
    cancelBootstrapDeadline()
    interfaceController = nil
    // Artwork was rendered for this car's screen scale, and the next one may
    // differ; holding decoded covers past the drive buys nothing either.
    CarPlayImageLoader.shared.removeAll()
    onDisconnect?()
  }

  func setRootTemplate(_ template: CPTemplate, animated: Bool) {
    NSLog("LUMENCP: setRootTemplate, hasController=\(interfaceController != nil)")
    // Only JS calls this method. Reaching it is the native proof that the
    // runtime, module, and first real root template all initialized.
    cancelBootstrapDeadline()
    interfaceController?.setRootTemplate(template, animated: animated, completion: nil)
  }

  func showRuntimeHostError(_ detail: String) {
    cancelBootstrapDeadline()
    showError(subtitle: detail)
  }

  /// An empty list with a spinner, rather than a row saying "Loading…": the
  /// placeholder is on screen for the second or two React Native takes to
  /// start, and a tappable-looking row that does nothing is worse than none.
  private func showPlaceholder() {
    let template = CPListTemplate(title: "Lumen", sections: [])
    template.emptyViewTitleVariants = ["Lumen"]
    template.emptyViewSubtitleVariants = ["Loading your library…"]
    if #available(iOS 18.4, *) {
      template.showsSpinnerWhileEmpty = true
    }
    interfaceController?.setRootTemplate(template, animated: false, completion: nil)
  }

  private func beginBootstrapDeadline() {
    cancelBootstrapDeadline()
    let deadline = DispatchWorkItem { [weak self] in
      guard let self, self.interfaceController != nil else { return }
#if DEBUG
      self.showError(
        subtitle: "Start Metro and open this project in the development client, or configure LUMEN_DEV_LAUNCH_URL, then reconnect CarPlay."
      )
#else
      self.showError(
        subtitle: "Lumen could not finish loading. Disconnect and reconnect CarPlay. If the problem continues, relaunch Lumen."
      )
#endif
    }
    bootstrapDeadline = deadline
    DispatchQueue.main.asyncAfter(
      deadline: .now() + bootstrapTimeout,
      execute: deadline
    )
  }

  private func cancelBootstrapDeadline() {
    bootstrapDeadline?.cancel()
    bootstrapDeadline = nil
  }

  private func showError(subtitle: String) {
    NSLog("LUMENCP: React bootstrap failed")
    let template = CPListTemplate(title: "Lumen", sections: [])
    template.emptyViewTitleVariants = ["Unable to start Lumen"]
    template.emptyViewSubtitleVariants = [subtitle]
    if #available(iOS 18.4, *) {
      template.showsSpinnerWhileEmpty = false
    }
    interfaceController?.setRootTemplate(template, animated: false, completion: nil)
  }
}
