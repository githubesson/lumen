import AppKit
import React

/// Vibrancy surface for the sidebar, the floating dock and the Now Playing
/// overlay. AppKit materials react to the system appearance and to what is
/// behind the window, which is the single biggest cue separating a Mac app from
/// a translucent-looking rectangle.
///
/// This subclasses `RCTView` and hosts the `NSVisualEffectView` as a background
/// child rather than being one: React Native's view manager applies the whole
/// standard view prop set (`mouseDownCanMoveWindow`, borders, opacity, …) to
/// whatever the manager returns, and anything that is not an `RCTView` dies on
/// `doesNotRecognizeSelector` the first time one of those props is set.
final class LMVisualEffectView: RCTView {
  private let effectView = NSVisualEffectView(frame: .zero)

  @objc var materialName: NSString = "sidebar" {
    didSet { effectView.material = LMVisualEffectView.material(named: materialName as String) }
  }

  @objc var blendingModeName: NSString = "behindWindow" {
    didSet {
      effectView.blendingMode =
        (blendingModeName as String) == "withinWindow" ? .withinWindow : .behindWindow
    }
  }

  /// Rounds the vibrancy itself so the blur stops at the corner instead of
  /// bleeding past it.
  @objc var cornerRadius: CGFloat = 0 {
    didSet {
      effectView.wantsLayer = true
      effectView.layer?.cornerRadius = cornerRadius
      effectView.layer?.masksToBounds = cornerRadius > 0
    }
  }

  /// Sidebars normally dim when the window loses key; opting out keeps the
  /// floating dock legible while another app is focused on top.
  @objc var alwaysActive: Bool = false {
    didSet { effectView.state = alwaysActive ? .active : .followsWindowActiveState }
  }

  /// Fade the material out over this many points at the bottom edge.
  ///
  /// This is what makes a scroll-edge header: the blur is at full strength
  /// behind the title and dissolves to nothing at its lower edge, so rows
  /// scrolling out of view are seen fading into it rather than being cut off
  /// by a hard line.
  ///
  /// Implemented as a `CAGradientLayer` mask on the effect view's backing
  /// layer rather than `maskImage`: with within-window blending, setting
  /// `maskImage` silently blanks the whole material.
  @objc var fadeBottom: CGFloat = 0 {
    didSet { updateMask() }
  }

  private var fadeMask: CAGradientLayer?

  private func updateMask() {
    guard fadeBottom > 0 else {
      fadeMask = nil
      effectView.layer?.mask = nil
      return
    }
    effectView.wantsLayer = true
    let mask = fadeMask ?? CAGradientLayer()
    fadeMask = mask
    mask.colors = [
      NSColor.black.withAlphaComponent(0).cgColor,
      NSColor.black.cgColor,
      NSColor.black.cgColor,
    ]
    layoutFadeMask()
    effectView.layer?.mask = mask
  }

  private func layoutFadeMask() {
    guard let mask = fadeMask, fadeBottom > 0 else { return }
    let height = max(bounds.height, 1)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    mask.frame = CGRect(x: 0, y: 0, width: bounds.width, height: height)
    // The backing layer is y-up: gradient location 0 is the bottom edge.
    mask.locations = [0, NSNumber(value: min(1, fadeBottom / height)), 1]
    CATransaction.commit()
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    effectView.material = .sidebar
    effectView.blendingMode = .behindWindow
    effectView.state = .followsWindowActiveState
    effectView.autoresizingMask = [.width, .height]
    addSubview(effectView, positioned: .below, relativeTo: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMVisualEffectView is created programmatically only")
  }

  override func didAddSubview(_ subview: NSView) {
    super.didAddSubview(subview)
    // React inserts its children with no knowledge of the backdrop, so push the
    // material back down whenever content lands on top of it.
    if subview !== effectView, subviews.first !== effectView {
      effectView.removeFromSuperview()
      addSubview(effectView, positioned: .below, relativeTo: nil)
    }
  }

  override func layout() {
    super.layout()
    effectView.frame = bounds
    layoutFadeMask()
  }

  static func material(named name: String) -> NSVisualEffectView.Material {
    switch name {
    case "titlebar": return .titlebar
    case "selection": return .selection
    case "menu": return .menu
    case "popover": return .popover
    case "sidebar": return .sidebar
    case "headerView": return .headerView
    case "sheet": return .sheet
    case "windowBackground": return .windowBackground
    case "hudWindow": return .hudWindow
    case "fullScreenUI": return .fullScreenUI
    case "toolTip": return .toolTip
    case "contentBackground": return .contentBackground
    case "underWindowBackground": return .underWindowBackground
    case "underPageBackground": return .underPageBackground
    default: return .sidebar
    }
  }
}

@objc(LMVisualEffectViewManager)
final class LMVisualEffectViewManager: RCTViewManager {
  override func view() -> NSView! {
    return LMVisualEffectView(frame: .zero)
  }

  override class func requiresMainQueueSetup() -> Bool {
    return true
  }
}
