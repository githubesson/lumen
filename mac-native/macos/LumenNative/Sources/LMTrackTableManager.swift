import AppKit
import React

@objc(LMTrackTableManager)
final class LMTrackTableManager: RCTViewManager {
  override func view() -> NSView! {
    return LMTrackTableHost(frame: .zero)
  }

  override class func requiresMainQueueSetup() -> Bool { true }

  /// Flip one row's favorite state without sending the whole list again.
  /// Favoriting is the most frequent update a track list gets, and a prop
  /// change would re-serialize every row and reload the table.
  @objc func setFavorite(_ reactTag: NSNumber, id: String, isFavorite: Bool) {
    bridge.uiManager.addUIBlock { _, viewRegistry in
      guard let host = viewRegistry?[reactTag] as? LMTrackTableHost else { return }
      host.setFavorite(id: id, isFavorite: isFavorite)
    }
  }
}
