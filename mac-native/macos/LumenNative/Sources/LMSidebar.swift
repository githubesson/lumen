import AppKit

/// The window's sidebar, built from `NSOutlineView` in source-list style.
///
/// This replaced a hand-drawn React Native sidebar. Apple's guidance is
/// explicit — "Avoid creating custom window UI … Custom frames or controls risk
/// making your app feel broken" (HIG, Windows) — and the custom version missed
/// everything the real control gets for free: the inset rounded selection,
/// correct group-header typography and spacing, sidebar vibrancy, the collapse
/// animation, keyboard navigation, and the macOS 26 appearance.

struct LMSidebarItem {
  let id: String
  let label: String
  let symbol: String
}

final class LMSidebarSection {
  let title: String?
  let items: [LMSidebarItem]

  init(title: String?, items: [LMSidebarItem]) {
    self.title = title
    self.items = items
  }
}

final class LMSidebarViewController: NSViewController {
  /// The live instance, so the bridge module can reach the sidebar without
  /// threading a reference through the whole responder chain.
  static private(set) weak var current: LMSidebarViewController?

  var onSelect: ((String) -> Void)?

  private let scrollView = NSScrollView()
  private let outlineView = NSOutlineView()
  private var sections: [LMSidebarSection] = []
  private var isApplyingSelectionFromJS = false

  override func loadView() {
    outlineView.style = .sourceList
    outlineView.selectionHighlightStyle = .regular
    outlineView.headerView = nil
    outlineView.rowSizeStyle = .medium
    outlineView.floatsGroupRows = false
    outlineView.allowsMultipleSelection = false
    outlineView.allowsEmptySelection = true
    outlineView.focusRingType = .none
    outlineView.backgroundColor = .clear
    outlineView.autoresizesOutlineColumn = false
    outlineView.indentationPerLevel = 0
    outlineView.delegate = self
    outlineView.dataSource = self

    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("sidebar"))
    column.resizingMask = .autoresizingMask
    outlineView.addTableColumn(column)
    outlineView.outlineTableColumn = column

    scrollView.documentView = outlineView
    scrollView.hasVerticalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.drawsBackground = false
    scrollView.borderType = .noBorder

    view = scrollView
    LMSidebarViewController.current = self
  }

  override func viewDidAppear() {
    super.viewDidAppear()
    hidePaneBackdrop()
  }

  override func viewDidLayout() {
    super.viewDidLayout()
    hidePaneBackdrop()
  }

  /// Keep the sidebar pane on the window's shared backdrop.
  ///
  /// macOS 26 lays a full-pane backdrop under the sidebar's glass island — an
  /// `NSBlurryAlleywayView` holding a `CABackdropLayer` — which tints the whole
  /// pane several shades darker than the rest of the window. That was the hard
  /// seam at the divider. It is a private, unexposed child of the split item's
  /// wrapper view, so it is found by class name and hidden; the island's own
  /// glass and the sidebar rows are untouched. Re-run from `viewDidLayout`
  /// because AppKit can reinstall it (e.g. on an appearance change).
  private func hidePaneBackdrop() {
    var cursor: NSView? = view
    while let current = cursor {
      guard let parent = current.superview else { return }
      if parent is NSSplitView {
        for sibling in current.subviews
        where NSStringFromClass(type(of: sibling)).contains("BlurryAlleyway") {
          sibling.isHidden = true
        }
        return
      }
      cursor = parent
    }
  }

  func apply(sections: [LMSidebarSection], selectedId: String?) {
    self.sections = sections
    outlineView.reloadData()
    for section in sections where section.title != nil {
      outlineView.expandItem(section)
    }
    select(id: selectedId)
  }

  func select(id: String?) {
    guard let id else { return }
    for section in sections {
      guard let item = section.items.first(where: { $0.id == id }) else { continue }
      let row = outlineView.row(forItem: item.id)
      guard row >= 0 else { return }
      // Guard the echo: selecting here fires the delegate, which would emit an
      // event back to JS, which would set the selection again.
      isApplyingSelectionFromJS = true
      outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
      isApplyingSelectionFromJS = false
      return
    }
  }

  private func item(forID id: String) -> LMSidebarItem? {
    for section in sections {
      if let match = section.items.first(where: { $0.id == id }) { return match }
    }
    return nil
  }
}

// MARK: - Data source

extension LMSidebarViewController: NSOutlineViewDataSource, NSOutlineViewDelegate {
  func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
    if item == nil {
      // Sections with no title are flattened, so their rows sit at the top
      // level with no header above them.
      return sections.reduce(0) { $0 + ($1.title == nil ? $1.items.count : 1) }
    }
    if let section = item as? LMSidebarSection { return section.items.count }
    return 0
  }

  func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
    if let section = item as? LMSidebarSection { return section.items[index].id }
    var cursor = index
    for section in sections {
      if section.title == nil {
        if cursor < section.items.count { return section.items[cursor].id }
        cursor -= section.items.count
      } else {
        if cursor == 0 { return section }
        cursor -= 1
      }
    }
    return ""
  }

  func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
    item is LMSidebarSection
  }

  func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool {
    item is LMSidebarSection
  }

  func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
    !(item is LMSidebarSection)
  }

  func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
    item is LMSidebarSection ? 26 : 28
  }

  func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any)
    -> NSView?
  {
    if let section = item as? LMSidebarSection {
      let identifier = NSUserInterfaceItemIdentifier("SidebarHeader")
      let cell =
        outlineView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView
        ?? {
          let created = NSTableCellView()
          created.identifier = identifier
          let label = NSTextField(labelWithString: "")
          label.translatesAutoresizingMaskIntoConstraints = false
          created.addSubview(label)
          created.textField = label
          NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: created.leadingAnchor),
            label.centerYAnchor.constraint(equalTo: created.centerYAnchor),
          ])
          return created
        }()
      // AppKit styles group rows itself in source-list mode; only the string
      // is ours.
      cell.textField?.stringValue = section.title ?? ""
      return cell
    }

    guard let id = item as? String, let model = self.item(forID: id) else { return nil }
    let identifier = NSUserInterfaceItemIdentifier("SidebarItem")
    let cell =
      outlineView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView
      ?? {
        let created = NSTableCellView()
        created.identifier = identifier

        let icon = NSImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.symbolConfiguration = .init(pointSize: 13, weight: .regular)
        created.addSubview(icon)
        created.imageView = icon

        let label = NSTextField(labelWithString: "")
        label.translatesAutoresizingMaskIntoConstraints = false
        label.lineBreakMode = .byTruncatingTail
        label.font = .systemFont(ofSize: 13)
        created.addSubview(label)
        created.textField = label

        NSLayoutConstraint.activate([
          icon.leadingAnchor.constraint(equalTo: created.leadingAnchor),
          icon.centerYAnchor.constraint(equalTo: created.centerYAnchor),
          icon.widthAnchor.constraint(equalToConstant: 20),
          label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 6),
          label.trailingAnchor.constraint(equalTo: created.trailingAnchor, constant: -4),
          label.centerYAnchor.constraint(equalTo: created.centerYAnchor),
        ])
        return created
      }()

    cell.textField?.stringValue = model.label
    cell.imageView?.image = NSImage(
      systemSymbolName: model.symbol, accessibilityDescription: nil)
    return cell
  }

  func outlineViewSelectionDidChange(_ notification: Notification) {
    guard !isApplyingSelectionFromJS else { return }
    let row = outlineView.selectedRow
    guard row >= 0, let id = outlineView.item(atRow: row) as? String else { return }
    onSelect?(id)
  }
}
