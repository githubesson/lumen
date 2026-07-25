import AppKit
import React

/// SF Symbols rendered by AppKit. The iOS client already names every icon with
/// `expo-symbols`, so those names carry over verbatim and both clients stay
/// visually identical without shipping an icon font or asset set.
///
/// Hosts an `NSImageView` inside an `RCTView` for the same reason as
/// `LMVisualEffectView`: React Native applies the standard view prop set to the
/// view a manager returns, and a bare `NSImageView` does not implement it.
final class LMSFSymbolView: RCTView {
  private let imageView = NSImageView(frame: .zero)

  @objc var symbolName: NSString = "" {
    didSet { refreshSymbol() }
  }

  @objc var pointSize: CGFloat = 15 {
    didSet { refreshSymbol() }
  }

  @objc var weightName: NSString = "regular" {
    didSet { refreshSymbol() }
  }

  /// SF Symbols are template images, so tinting is a content-tint change rather
  /// than a re-render.
  @objc var tintColor: NSColor? {
    didSet { imageView.contentTintColor = tintColor }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.autoresizingMask = [.width, .height]
    addSubview(imageView)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMSFSymbolView is created programmatically only")
  }

  override func layout() {
    super.layout()
    imageView.frame = bounds
  }

  private func refreshSymbol() {
    let name = symbolName as String
    guard !name.isEmpty,
          let symbol = NSImage(systemSymbolName: name, accessibilityDescription: name)
    else {
      // An unknown symbol name renders as nothing rather than crashing: symbol
      // availability differs per macOS version and a missing glyph must not
      // take down a list row.
      imageView.image = nil
      return
    }
    let configuration = NSImage.SymbolConfiguration(
      pointSize: pointSize,
      weight: LMSFSymbolView.weight(named: weightName as String)
    )
    imageView.image = symbol.withSymbolConfiguration(configuration)
  }

  static func weight(named name: String) -> NSFont.Weight {
    switch name {
    case "ultraLight": return .ultraLight
    case "thin": return .thin
    case "light": return .light
    case "regular": return .regular
    case "medium": return .medium
    case "semibold": return .semibold
    case "bold": return .bold
    case "heavy": return .heavy
    case "black": return .black
    default: return .regular
    }
  }
}

@objc(LMSFSymbolViewManager)
final class LMSFSymbolViewManager: RCTViewManager {
  override func view() -> NSView! {
    return LMSFSymbolView(frame: .zero)
  }

  override class func requiresMainQueueSetup() -> Bool {
    return true
  }
}
