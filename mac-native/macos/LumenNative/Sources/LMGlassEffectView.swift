import AppKit
import React

/// Liquid Glass surface.
///
/// macOS 26 introduced `NSGlassEffectView`, which is what the system's own
/// floating controls use — it refracts and tints what is behind it and reacts to
/// motion, where `NSVisualEffectView` only blurs. Anything that floats above
/// content (the dock, the Now Playing panel) should be glass so it matches the
/// rest of the OS. Older systems fall back to a vibrancy material.
final class LMGlassEffectView: RCTView {
  private var glassView: NSView?
  private var fallbackView: NSVisualEffectView?

  @objc var cornerRadius: CGFloat = 0 {
    didSet { applyCornerRadius() }
  }

  /// `regular` is the standard chrome glass; `clear` is thinner and lets more
  /// of the content through, which suits a large panel over artwork.
  @objc var glassStyle: NSString = "regular" {
    didSet { applyStyle() }
  }

  @objc var tintColor: NSColor? {
    didSet {
      if #available(macOS 26.0, *) {
        (glassView as? NSGlassEffectView)?.tintColor = tintColor
      }
    }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)

    if #available(macOS 26.0, *) {
      let glass = NSGlassEffectView(frame: frameRect)
      glass.autoresizingMask = [.width, .height]
      glassView = glass
      addSubview(glass, positioned: .below, relativeTo: nil)
    } else {
      let fallback = NSVisualEffectView(frame: frameRect)
      fallback.material = .hudWindow
      fallback.blendingMode = .withinWindow
      fallback.state = .active
      fallback.autoresizingMask = [.width, .height]
      fallbackView = fallback
      addSubview(fallback, positioned: .below, relativeTo: nil)
    }
    applyStyle()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMGlassEffectView is created programmatically only")
  }

  override func didAddSubview(_ subview: NSView) {
    super.didAddSubview(subview)
    // React inserts children with no knowledge of the backdrop, so keep the
    // glass beneath whatever lands on top of it.
    guard let backdrop = glassView ?? fallbackView else { return }
    if subview !== backdrop, subviews.first !== backdrop {
      backdrop.removeFromSuperview()
      addSubview(backdrop, positioned: .below, relativeTo: nil)
    }
  }

  override func layout() {
    super.layout()
    (glassView ?? fallbackView)?.frame = bounds
  }

  private func applyStyle() {
    guard #available(macOS 26.0, *), let glass = glassView as? NSGlassEffectView else {
      return
    }
    glass.style = (glassStyle as String) == "clear" ? .clear : .regular
  }

  private func applyCornerRadius() {
    if #available(macOS 26.0, *), let glass = glassView as? NSGlassEffectView {
      // The glass rounds itself, so the refraction follows the corner instead
      // of being clipped by a parent layer.
      glass.cornerRadius = cornerRadius
      return
    }
    fallbackView?.wantsLayer = true
    fallbackView?.layer?.cornerRadius = cornerRadius
    fallbackView?.layer?.masksToBounds = cornerRadius > 0
  }
}

@objc(LMGlassEffectViewManager)
final class LMGlassEffectViewManager: RCTViewManager {
  override func view() -> NSView! {
    return LMGlassEffectView(frame: .zero)
  }

  override class func requiresMainQueueSetup() -> Bool {
    return true
  }
}
