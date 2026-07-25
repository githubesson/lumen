import AppKit

/// The window toolbar.
///
/// `NSToolbar` is the only way to get the macOS 26 chrome: the capsule search
/// field, the bordered icon buttons, the automatic Liquid Glass treatment, the
/// sidebar-tracking separator and the scroll edge effect underneath. A custom
/// view in the same position gets none of it, which is why the hand-drawn
/// version read as an older release of macOS.
@objc(LMToolbarController)
final class LMToolbarController: NSObject, NSToolbarDelegate, NSSearchFieldDelegate {
  var onSearch: ((String) -> Void)?
  var onSegment: ((Int) -> Void)?
  var onToggleSidebar: (() -> Void)?
  var onBack: (() -> Void)?

  private weak var window: NSWindow?
  private var toolbar: NSToolbar?

  private var showsBack = false
  private var showsSearch = false
  private var searchPlaceholder = "Search"
  private var segmentLabels: [String] = []
  private var selectedSegment = 0

  private lazy var searchItem: NSSearchToolbarItem = {
    let item = NSSearchToolbarItem(itemIdentifier: .search)
    item.searchField.delegate = self
    item.searchField.placeholderString = searchPlaceholder
    item.searchField.sendsWholeSearchString = false
    item.searchField.sendsSearchStringImmediately = true
    item.resignsFirstResponderWithCancel = true
    return item
  }()

  private lazy var segmentedControl: NSSegmentedControl = {
    let control = NSSegmentedControl(labels: [], trackingMode: .selectOne, target: self,
                                     action: #selector(handleSegment))
    control.segmentStyle = .automatic
    return control
  }()

  func attach(to window: NSWindow) {
    guard toolbar == nil else { return }
    let toolbar = NSToolbar(identifier: "LumenToolbar")
    toolbar.delegate = self
    toolbar.displayMode = .iconOnly
    toolbar.allowsUserCustomization = false
    window.toolbar = toolbar
    // `.unified` merges the toolbar into the titlebar, which is what gives the
    // window the taller macOS 26 corner radius and lets the sidebar run up
    // behind it.
    window.toolbarStyle = .unified
    self.toolbar = toolbar
    self.window = window
  }

  func configure(
    showsBack: Bool,
    showsSearch: Bool,
    searchPlaceholder: String,
    segments: [String],
    selectedSegment: Int
  ) {
    self.showsBack = showsBack
    self.showsSearch = showsSearch
    self.searchPlaceholder = searchPlaceholder
    self.selectedSegment = selectedSegment
    searchItem.searchField.placeholderString = searchPlaceholder

    if segments != segmentLabels {
      segmentLabels = segments
      segmentedControl.segmentCount = segments.count
      for (index, label) in segments.enumerated() {
        segmentedControl.setLabel(label, forSegment: index)
        segmentedControl.setWidth(0, forSegment: index)
      }
      segmentedControl.sizeToFit()
    }
    if segmentedControl.segmentCount > selectedSegment {
      segmentedControl.selectedSegment = selectedSegment
    }

    rebuildItems()
  }

  func setSearchText(_ text: String) {
    if searchItem.searchField.stringValue != text {
      searchItem.searchField.stringValue = text
    }
  }

  func focusSearch() {
    guard showsSearch else { return }
    window?.makeFirstResponder(searchItem.searchField)
  }

  private func rebuildItems() {
    guard let toolbar else { return }
    while toolbar.items.count > 0 {
      toolbar.removeItem(at: toolbar.items.count - 1)
    }
    for (index, identifier) in currentIdentifiers().enumerated() {
      toolbar.insertItem(withItemIdentifier: identifier, at: index)
    }
  }

  private func currentIdentifiers() -> [NSToolbarItem.Identifier] {
    var ids: [NSToolbarItem.Identifier] = [.toggleSidebar, .sidebarTrackingSeparator]
    if showsBack { ids.append(.back) }
    ids.append(.flexibleSpace)
    if !segmentLabels.isEmpty { ids.append(.segments) }
    if showsSearch { ids.append(.search) }
    return ids
  }

  @objc private func handleSegment() {
    onSegment?(segmentedControl.selectedSegment)
  }

  @objc private func handleBack() {
    onBack?()
  }

  func controlTextDidChange(_ obj: Notification) {
    guard let field = obj.object as? NSSearchField else { return }
    onSearch?(field.stringValue)
  }

  // MARK: NSToolbarDelegate

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [.toggleSidebar, .sidebarTrackingSeparator, .back, .flexibleSpace, .segments, .search]
  }

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    currentIdentifiers()
  }

  func toolbar(
    _ toolbar: NSToolbar,
    itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
    willBeInsertedIntoToolbar flag: Bool
  ) -> NSToolbarItem? {
    switch itemIdentifier {
    case .back:
      let item = NSToolbarItem(itemIdentifier: .back)
      item.image = NSImage(
        systemSymbolName: "chevron.backward", accessibilityDescription: "Back")
      item.label = "Back"
      item.toolTip = "Back"
      item.isBordered = true
      // Navigational items sit at the leading edge of the content area, right
      // after the sidebar's tracking separator — where every Mac app puts back.
      item.isNavigational = true
      item.target = self
      item.action = #selector(handleBack)
      return item
    case .search:
      return searchItem
    case .segments:
      let item = NSToolbarItem(itemIdentifier: .segments)
      item.view = segmentedControl
      return item
    default:
      // `.toggleSidebar` and `.sidebarTrackingSeparator` are supplied by AppKit
      // and wired to the split view controller automatically.
      return nil
    }
  }
}

extension NSToolbarItem.Identifier {
  static let back = NSToolbarItem.Identifier("lumen.back")
  static let search = NSToolbarItem.Identifier("lumen.search")
  static let segments = NSToolbarItem.Identifier("lumen.segments")
}
