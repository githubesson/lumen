import AppKit
import React

/// React Native host for `LMTrackTableView`.
///
/// Subclasses `RCTView` because React Native applies its whole standard view
/// prop set to whatever a view manager returns. Layout is frame-based: Yoga
/// sizes this container, and the scroll view simply fills it — constraints
/// against an RN parent do not work, since RN does not participate in Auto
/// Layout.
final class LMTrackTableHost: RCTView {
  private let scrollView = NSScrollView()
  private let tableView = LMTrackTableView()

  private var rows: [LMTrackRow] = []
  private var indexByID: [String: Int] = [:]
  private var rowsDirty = false
  private var nowPlayingDirty = false
  private var appliedTopInset: CGFloat = 0
  /// Row count at the last `onEndReached`, so one scroll into the tail asks for
  /// one page. A page that arrives changes the count and re-arms it; a page
  /// that comes back empty leaves it armed against the same count and the
  /// event stays quiet.
  private var endReachedRowCount = -1
  private var scrollObserver: NSObjectProtocol?

  /// Hosts the screen's React-rendered header (a playlist hero, say) inside the
  /// scroll surface, so it scrolls away with the rows instead of sitting above
  /// them. Lives in the clip view — siblings of the document view there share
  /// its coordinate space and scroll with it — at negative y, in the room the
  /// `topInset` opens up.
  private let headerContainer = LMHeaderContainerView()
  private var headerObserver: NSObjectProtocol?

  @objc var onRowActivated: RCTDirectEventBlock?
  @objc var onRowContextMenu: RCTDirectEventBlock?
  @objc var onEndReached: RCTDirectEventBlock?

  @objc var rowHeight: CGFloat = 56 {
    didSet { tableView.rowHeight = rowHeight }
  }

  /// Room for the floating screen header the list scrolls underneath.
  @objc var topInset: CGFloat = 0 {
    didSet { applyInsets() }
  }

  @objc var bottomInset: CGFloat = 0 {
    didSet { applyInsets() }
  }

  @objc var nowPlayingId: NSString? {
    didSet { nowPlayingDirty = true }
  }

  @objc var accentColor: NSColor? {
    didSet { tableView.reloadData() }
  }

  /// Columnar row data: parallel arrays keyed `ids`, `titles`, `artists`,
  /// `albums`, `durations`, `artworkUrls`, `favorites`. Sending an array of
  /// dictionaries instead would repeat every key hundreds of times and
  /// allocate a dictionary per row crossing the bridge.
  @objc var rowData: NSDictionary = [:] {
    didSet { rowsDirty = true }
  }

  // RN's frames are top-left origin, matching RCTUIView.
  override var isFlipped: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)

    tableView.style = .inset  // rounded, inset selection — the modern list look
    tableView.selectionHighlightStyle = .regular
    tableView.usesAlternatingRowBackgroundColors = false
    tableView.usesAutomaticRowHeights = false
    tableView.rowHeight = rowHeight
    tableView.intercellSpacing = .zero
    tableView.gridStyleMask = []
    tableView.headerView = nil
    tableView.allowsMultipleSelection = true
    tableView.allowsEmptySelection = true
    tableView.allowsColumnReordering = false
    tableView.allowsColumnSelection = false
    tableView.allowsTypeSelect = true
    tableView.focusRingType = .none
    // Transparent so the pane's vibrancy shows through the list, which is what
    // keeps the content pane and the sidebar reading as one surface.
    // `LMTrackRowView` draws the selection pill itself, since AppKit only draws
    // the `.inset` style one for a table with an opaque background.
    tableView.backgroundColor = .clear
    tableView.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
    tableView.delegate = self
    tableView.dataSource = self
    tableView.target = self
    tableView.doubleAction = #selector(handleDoubleClick)
    tableView.onHoverChange = { [weak self] previous, current in
      self?.applyHover(previous: previous, current: current)
    }
    tableView.onContextMenu = { [weak self] row, point in
      self?.requestContextMenu(row: row, at: point)
    }

    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("track"))
    column.resizingMask = .autoresizingMask
    tableView.addTableColumn(column)

    scrollView.documentView = tableView
    scrollView.hasVerticalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.drawsBackground = false
    scrollView.borderType = .noBorder
    scrollView.automaticallyAdjustsContentInsets = false
    addSubview(scrollView)

    // One observer for the whole list: it drives paging, and the clip view is
    // the only thing that reports both wheel scrolling and scroller drags.
    scrollView.contentView.postsBoundsChangedNotifications = true
    scrollObserver = NotificationCenter.default.addObserver(
      forName: NSView.boundsDidChangeNotification,
      object: scrollView.contentView,
      queue: .main
    ) { [weak self] _ in
      self?.checkEndReached()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMTrackTableHost is created programmatically only")
  }

  deinit {
    if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }
    if let headerObserver { NotificationCenter.default.removeObserver(headerObserver) }
  }

  override func layout() {
    super.layout()
    scrollView.frame = bounds
    layoutHeader()
  }

  private func applyInsets() {
    let insets = NSEdgeInsets(top: topInset, left: 0, bottom: bottomInset, right: 0)
    // Resting position at the top of a list with a top inset is `-topInset`, so
    // a list already parked at the top has to be nudged to the new one —
    // otherwise the first rows start out hidden behind the header.
    let wasAtTop = scrollView.contentView.bounds.origin.y <= -appliedTopInset + 1
    scrollView.contentInsets = insets
    scrollView.scrollerInsets = insets
    appliedTopInset = topInset
    if wasAtTop {
      scrollView.contentView.scroll(to: NSPoint(x: 0, y: -topInset))
      scrollView.reflectScrolledClipView(scrollView.contentView)
    }
  }

  /// Ask JS for another page once the tail is within a screenful.
  private func checkEndReached() {
    guard let onEndReached, !rows.isEmpty, endReachedRowCount != rows.count else { return }
    let visible = scrollView.documentVisibleRect
    let contentHeight = tableView.bounds.height
    guard contentHeight > 0, visible.maxY >= contentHeight - max(visible.height, rowHeight * 8)
    else { return }
    endReachedRowCount = rows.count
    onEndReached([:])
  }

  /// React Native calls this once per batch, after every prop in that batch has
  /// been applied — so a change to rows and now-playing together costs one
  /// reload rather than two.
  override func didSetProps(_ changedProps: [String]!) {
    super.didSetProps(changedProps)
    if rowsDirty {
      rebuildRows()
      tableView.reloadData()
      rowsDirty = false
      nowPlayingDirty = false
    }
    if nowPlayingDirty {
      refreshVisibleRows()
      nowPlayingDirty = false
    }
    // A first page shorter than the window never scrolls, so nothing would ever
    // ask for the second one.
    DispatchQueue.main.async { [weak self] in self?.checkEndReached() }
  }

  /// The table owns its own scrolling, so a React child cannot simply sit in
  /// this container — it is placed into the scroll surface as the list's
  /// scrolling header. One child is supported; RN keeps laying it out (Yoga
  /// gives it the table's width and its natural height), and the frame
  /// observer mirrors that size onto the container above the first row.
  ///
  /// The base `insertReactSubview`/`removeReactSubview` bookkeeping must run:
  /// Fabric's legacy interop unmounts children by looking them up in
  /// `reactSubviews`, and a child missing from that array is never detached —
  /// which trips the "attempt to recycle a mounted view" assert (and crashed
  /// the app) when the screen is popped. Attachment is customised in
  /// `didUpdateReactSubviews` instead, which is the designated hook for it.
  override func didUpdateReactSubviews() {
    guard let subview = reactSubviews()?.first else {
      if let headerObserver { NotificationCenter.default.removeObserver(headerObserver) }
      headerObserver = nil
      headerContainer.removeFromSuperview()
      return
    }
    if headerContainer.superview == nil {
      scrollView.contentView.addSubview(headerContainer)
    }
    if subview.superview != headerContainer {
      headerContainer.addSubview(subview)
      subview.postsFrameChangedNotifications = true
      if let headerObserver { NotificationCenter.default.removeObserver(headerObserver) }
      headerObserver = NotificationCenter.default.addObserver(
        forName: NSView.frameDidChangeNotification,
        object: subview,
        queue: .main
      ) { [weak self] _ in
        self?.layoutHeader()
      }
    }
    layoutHeader()
  }

  override func removeReactSubview(_ subview: NSView!) {
    if subview?.superview == headerContainer {
      if let headerObserver { NotificationCenter.default.removeObserver(headerObserver) }
      headerObserver = nil
    }
    // Base implementation drops it from `reactSubviews` and detaches it.
    super.removeReactSubview(subview)
    if headerContainer.subviews.isEmpty {
      headerContainer.removeFromSuperview()
    }
  }

  private func layoutHeader() {
    guard let content = headerContainer.subviews.first else { return }
    let size = content.frame.size
    headerContainer.frame = CGRect(x: 0, y: -size.height, width: size.width, height: size.height)
    // RN positions the child where Yoga put it inside this host; inside the
    // container it must sit at the origin instead.
    if content.frame.origin != .zero {
      content.frame.origin = .zero
    }
  }

  private func rebuildRows() {
    let ids = rowData["ids"] as? [String] ?? []
    let titles = rowData["titles"] as? [String] ?? []
    let artists = rowData["artists"] as? [String] ?? []
    let albums = rowData["albums"] as? [String] ?? []
    let durations = rowData["durations"] as? [String] ?? []
    let artworkUrls = rowData["artworkUrls"] as? [String] ?? []
    let favorites = rowData["favorites"] as? [Int] ?? []

    func at(_ array: [String], _ index: Int) -> String {
      index < array.count ? array[index] : ""
    }

    rows = ids.enumerated().map { index, id in
      let artwork = at(artworkUrls, index)
      return LMTrackRow(
        id: id,
        title: at(titles, index),
        artist: at(artists, index),
        album: at(albums, index),
        duration: at(durations, index),
        artworkURL: artwork.isEmpty ? nil : URL(string: artwork),
        isFavorite: index < favorites.count && favorites[index] == 1
      )
    }
    indexByID = Dictionary(
      rows.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
    // A shorter list means a different query — a new search, a different
    // screen — so paging starts over rather than staying latched.
    if rows.count < endReachedRowCount { endReachedRowCount = -1 }
  }

  /// Repaint only what is on screen. `makeIfNecessary: false` means offscreen
  /// rows cost nothing, which is the whole point of not calling `reloadData`.
  private func refreshVisibleRows() {
    let visible = tableView.rows(in: tableView.visibleRect)
    guard visible.length > 0 else { return }
    for row in visible.lowerBound..<visible.upperBound where row < rows.count {
      guard
        let cell = tableView.view(atColumn: 0, row: row, makeIfNecessary: false)
          as? LMTrackCellView
      else { continue }
      cell.configure(with: rows[row], isNowPlaying: rows[row].id == nowPlayingId as String?)
    }
  }

  private func applyHover(previous: Int, current: Int) {
    for row in [previous, current] where row >= 0 && row < rows.count {
      let hovered = row == current
      (tableView.view(atColumn: 0, row: row, makeIfNecessary: false) as? LMTrackCellView)?
        .isHovered = hovered
      (tableView.rowView(atRow: row, makeIfNecessary: false) as? LMTrackRowView)?
        .isHovered = hovered
    }
  }

  @objc private func handleDoubleClick() {
    // -1 when the click lands below the last row.
    let row = tableView.clickedRow
    guard row >= 0, row < rows.count else { return }
    onRowActivated?(["index": row, "id": rows[row].id])
  }

  /// Flip a single row's favorite state without reloading the table.
  func setFavorite(id: String, isFavorite: Bool) {
    guard let index = indexByID[id] else { return }
    rows[index].isFavorite = isFavorite
    (tableView.view(atColumn: 0, row: index, makeIfNecessary: false) as? LMTrackCellView)?
      .setFavorite(isFavorite)
  }

  func requestContextMenu(row: Int, at point: NSPoint) {
    guard row >= 0, row < rows.count else { return }
    onRowContextMenu?(["index": row, "id": rows[row].id, "x": point.x, "y": point.y])
  }
}

/// Flipped so the React content inside uses top-left origin, matching the
/// flipped clip view it scrolls in.
private final class LMHeaderContainerView: NSView {
  override var isFlipped: Bool { true }
}

// MARK: - Data source and delegate

extension LMTrackTableHost: NSTableViewDataSource, NSTableViewDelegate {
  func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

  func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
    let identifier = NSUserInterfaceItemIdentifier("TrackRow")
    if let existing = tableView.makeView(withIdentifier: identifier, owner: self)
      as? LMTrackRowView
    {
      return existing
    }
    let view = LMTrackRowView()
    view.identifier = identifier
    return view
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int)
    -> NSView?
  {
    let identifier = NSUserInterfaceItemIdentifier("TrackCell")
    let cell =
      tableView.makeView(withIdentifier: identifier, owner: self) as? LMTrackCellView
      ?? {
        let created = LMTrackCellView()
        // Without an identifier AppKit never enqueues the view for reuse, and
        // every row allocates a fresh cell.
        created.identifier = identifier
        return created
      }()
    if let accentColor { cell.accentColor = accentColor }
    cell.configure(with: rows[row], isNowPlaying: rows[row].id == nowPlayingId as String?)
    return cell
  }
}
