import AppKit
import React

/// Native AppKit controls.
///
/// Hand-drawn React Native equivalents never quite match: they miss the
/// system's focus rings, the Liquid Glass treatment macOS 26 gives real
/// controls, accessibility, and the small motion details AppKit does for free.
/// These wrap the genuine controls and report their value to JS.

// MARK: - Search field

final class LMSearchField: RCTView, NSSearchFieldDelegate {
  private let field = NSSearchField(frame: .zero)

  @objc var onSearchChange: RCTDirectEventBlock?
  @objc var onSearchSubmit: RCTDirectEventBlock?

  @objc var value: NSString = "" {
    didSet {
      if field.stringValue != (value as String) {
        field.stringValue = value as String
      }
    }
  }

  @objc var placeholder: NSString = "" {
    didSet { field.placeholderString = placeholder as String }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    field.delegate = self
    field.autoresizingMask = [.width]
    field.target = self
    field.action = #selector(handleAction)
    field.sendsWholeSearchString = false
    field.sendsSearchStringImmediately = true
    addSubview(field)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMSearchField is created programmatically only")
  }

  override func layout() {
    super.layout()
    let height = ceil(field.intrinsicContentSize.height)
    field.frame = NSRect(
      x: 0,
      y: max(0, (bounds.height - height) / 2),
      width: bounds.width,
      height: min(height, bounds.height)
    )
  }

  /// Focus the field the way ⌘F should.
  func focus() {
    window?.makeFirstResponder(field)
  }

  @objc private func handleAction() {
    onSearchSubmit?(["text": field.stringValue])
  }

  func controlTextDidChange(_ obj: Notification) {
    onSearchChange?(["text": field.stringValue])
  }
}

@objc(LMSearchFieldManager)
final class LMSearchFieldManager: RCTViewManager {
  override func view() -> NSView! {
    return LMSearchField(frame: .zero)
  }

  override class func requiresMainQueueSetup() -> Bool { true }

  /// ⌘F reaches the field through the view registry rather than a JS ref,
  /// because the field lives inside whichever screen is mounted.
  @objc func focus(_ reactTag: NSNumber) {
    bridge.uiManager.addUIBlock { _, viewRegistry in
      guard let view = viewRegistry?[reactTag] as? LMSearchField else { return }
      view.focus()
    }
  }
}

// MARK: - Segmented control

final class LMSegmentedControl: RCTView {
  private let control = NSSegmentedControl(frame: .zero)

  @objc var onSegmentChange: RCTDirectEventBlock?

  @objc var labels: NSArray = [] {
    didSet { rebuild() }
  }

  @objc var selectedIndex: NSInteger = 0 {
    didSet {
      if control.segmentCount > selectedIndex, control.selectedSegment != selectedIndex {
        control.selectedSegment = selectedIndex
      }
    }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    control.segmentStyle = .automatic
    control.trackingMode = .selectOne
    control.target = self
    control.action = #selector(handleChange)
    addSubview(control)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMSegmentedControl is created programmatically only")
  }

  override func layout() {
    super.layout()
    control.frame = bounds
  }

  override var intrinsicContentSize: NSSize {
    control.intrinsicContentSize
  }

  private func rebuild() {
    let titles = (labels as? [String]) ?? []
    control.segmentCount = titles.count
    for (index, title) in titles.enumerated() {
      control.setLabel(title, forSegment: index)
      control.setWidth(0, forSegment: index)
    }
    if control.segmentCount > selectedIndex {
      control.selectedSegment = selectedIndex
    }
    invalidateIntrinsicContentSize()
  }

  @objc private func handleChange() {
    onSegmentChange?(["index": control.selectedSegment])
  }
}

@objc(LMSegmentedControlManager)
final class LMSegmentedControlManager: RCTViewManager {
  override func view() -> NSView! {
    return LMSegmentedControl(frame: .zero)
  }

  override class func requiresMainQueueSetup() -> Bool { true }
}

// MARK: - Push button

final class LMButton: RCTView {
  private let button = NSButton(frame: .zero)

  @objc var onButtonPress: RCTDirectEventBlock?

  @objc var title: NSString = "" {
    didSet {
      button.title = title as String
      invalidateIntrinsicContentSize()
    }
  }

  /// `prominent` is the accent-filled default button; `destructive` tints red;
  /// `plain` is a borderless link-style button.
  @objc var buttonStyle: NSString = "normal" {
    didSet { applyStyle() }
  }

  @objc var enabled: Bool = true {
    didSet { button.isEnabled = enabled }
  }

  @objc var symbolName: NSString = "" {
    didSet {
      let name = symbolName as String
      button.image = name.isEmpty
        ? nil
        : NSImage(systemSymbolName: name, accessibilityDescription: name)
      button.imagePosition = name.isEmpty ? .noImage : .imageLeading
    }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    button.bezelStyle = .rounded
    button.target = self
    button.action = #selector(handlePress)
    addSubview(button)
    applyStyle()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMButton is created programmatically only")
  }

  override func layout() {
    super.layout()
    button.frame = bounds
  }

  override var intrinsicContentSize: NSSize {
    button.intrinsicContentSize
  }

  private func applyStyle() {
    switch buttonStyle as String {
    case "prominent":
      button.bezelStyle = .rounded
      button.isBordered = true
      button.hasDestructiveAction = false
      // keyEquivalent "\r" is what makes AppKit draw it as the default button.
      button.keyEquivalent = "\r"
    case "destructive":
      button.bezelStyle = .rounded
      button.isBordered = true
      button.hasDestructiveAction = true
      button.keyEquivalent = ""
    case "plain":
      button.isBordered = false
      button.hasDestructiveAction = false
      button.keyEquivalent = ""
      button.contentTintColor = .controlAccentColor
    default:
      button.bezelStyle = .rounded
      button.isBordered = true
      button.hasDestructiveAction = false
      button.keyEquivalent = ""
    }
    invalidateIntrinsicContentSize()
  }

  @objc private func handlePress() {
    onButtonPress?([:])
  }
}

@objc(LMButtonManager)
final class LMButtonManager: RCTViewManager {
  override func view() -> NSView! {
    return LMButton(frame: .zero)
  }

  override class func requiresMainQueueSetup() -> Bool { true }
}
