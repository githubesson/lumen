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

  /// Shown while JS is still booting. Kept as state so a failed bundle load can
  /// be surfaced in the car rather than hanging on "Loading" forever.
  private var placeholderText = "Loading your library…"

  func connect(interfaceController: CPInterfaceController) {
    NSLog("LUMENCP: connect, hasOnConnect=\(onConnect != nil)")
    self.interfaceController = interfaceController
    showPlaceholder()
    onConnect?()
  }

  func disconnect() {
    NSLog("LUMENCP: disconnect")
    interfaceController = nil
    // Artwork was rendered for this car's screen scale, and the next one may
    // differ; holding decoded covers past the drive buys nothing either.
    CarPlayImageLoader.shared.removeAll()
    onDisconnect?()
  }

  func setRootTemplate(_ template: CPTemplate, animated: Bool) {
    NSLog("LUMENCP: setRootTemplate, hasController=\(interfaceController != nil)")
    interfaceController?.setRootTemplate(template, animated: animated, completion: nil)
  }

  /// An empty list with a spinner, rather than a row saying "Loading…": the
  /// placeholder is on screen for the second or two React Native takes to
  /// start, and a tappable-looking row that does nothing is worse than none.
  private func showPlaceholder() {
    let template = CPListTemplate(title: "Lumen", sections: [])
    template.emptyViewTitleVariants = ["Lumen"]
    template.emptyViewSubtitleVariants = [placeholderText]
    if #available(iOS 18.4, *) {
      template.showsSpinnerWhileEmpty = true
    }
    interfaceController?.setRootTemplate(template, animated: false, completion: nil)
  }
}
