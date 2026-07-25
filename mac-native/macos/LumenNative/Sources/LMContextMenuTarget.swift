import AppKit
import React

/// A view that reports right-clicks to JS.
///
/// react-native-macos surfaces mouse enter/leave and double-click on `View`,
/// but nothing for the secondary button, so rows that want a context menu wrap
/// their content in this. It only reports the event — the menu itself is built
/// by `LMContextMenuModule` so every menu in the app goes through one path.
final class LMContextMenuTarget: RCTView {
  @objc var onContextMenu: RCTDirectEventBlock?

  override func rightMouseDown(with event: NSEvent) {
    guard let onContextMenu else {
      super.rightMouseDown(with: event)
      return
    }
    // Report in React's coordinate space (top-left origin) so the caller can
    // hand the point straight back to the context menu module.
    let localPoint = convert(event.locationInWindow, from: nil)
    let contentHeight = window?.contentView?.bounds.height ?? 0
    let windowPoint = event.locationInWindow
    onContextMenu([
      "x": windowPoint.x,
      "y": contentHeight - windowPoint.y,
      "localX": localPoint.x,
      "localY": localPoint.y,
    ])
  }

  /// Ctrl-click is the other way macOS raises a context menu.
  override func mouseDown(with event: NSEvent) {
    if event.modifierFlags.contains(.control), onContextMenu != nil {
      rightMouseDown(with: event)
      return
    }
    super.mouseDown(with: event)
  }
}

@objc(LMContextMenuTargetManager)
final class LMContextMenuTargetManager: RCTViewManager {
  override func view() -> NSView! {
    return LMContextMenuTarget(frame: .zero)
  }

  override class func requiresMainQueueSetup() -> Bool {
    return true
  }
}
