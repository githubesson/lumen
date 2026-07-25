import AppKit
import React

/// A password field backed by a real `NSSecureTextField`.
///
/// React Native's own `<TextInput secureTextEntry>` cannot be used here:
/// react-native-macos swaps its backing control for an `RCTUISecureTextField`
/// after mount, and the replacement stops emitting change/focus events, so the
/// typed password reaches AppKit but never reaches React state. Owning the
/// control means the delegate wiring is ours, and it also gets the genuine
/// AppKit secure-input behaviour (secure event input, password autofill).
final class LMSecureField: RCTView, NSTextFieldDelegate {
  private let field = NSSecureTextField(frame: .zero)

  @objc var onChangeText: RCTDirectEventBlock?
  @objc var onSubmit: RCTDirectEventBlock?
  @objc var onFocusChange: RCTDirectEventBlock?

  /// Mirrors React's value. Applied only when it actually differs so that
  /// re-renders during typing cannot move the insertion point.
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

  @objc var fontSize: CGFloat = 13 {
    didSet { field.font = .systemFont(ofSize: fontSize) }
  }

  @objc var textColor: NSColor? {
    didSet { field.textColor = textColor }
  }

  @objc var editable: Bool = true {
    didSet { field.isEditable = editable }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    field.delegate = self
    field.isBordered = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.font = .systemFont(ofSize: fontSize)
    field.lineBreakMode = .byClipping
    field.cell?.usesSingleLineMode = true
    field.cell?.wraps = false
    field.cell?.isScrollable = true
    field.autoresizingMask = [.width]
    // Enter should submit the form rather than insert a newline.
    field.target = self
    field.action = #selector(handleAction)
    addSubview(field)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMSecureField is created programmatically only")
  }

  override func layout() {
    super.layout()
    // Centre one line of text in the RN-laid-out box and inset it to match the
    // padding the JS `Field` chrome uses for regular text inputs.
    let inset: CGFloat = 10
    let height = ceil(field.intrinsicContentSize.height)
    let y = max(0, (bounds.height - height) / 2)
    field.frame = NSRect(
      x: inset,
      y: y,
      width: max(0, bounds.width - inset * 2),
      height: min(height, bounds.height)
    )
  }

  @objc private func handleAction() {
    onSubmit?(["text": field.stringValue])
  }

  // MARK: NSTextFieldDelegate

  func controlTextDidChange(_ obj: Notification) {
    onChangeText?(["text": field.stringValue])
  }

  func controlTextDidBeginEditing(_ obj: Notification) {
    onFocusChange?(["focused": true])
  }

  func controlTextDidEndEditing(_ obj: Notification) {
    onFocusChange?(["focused": false])
  }
}

@objc(LMSecureFieldManager)
final class LMSecureFieldManager: RCTViewManager {
  override func view() -> NSView! {
    return LMSecureField(frame: .zero)
  }

  override class func requiresMainQueueSetup() -> Bool {
    return true
  }
}
