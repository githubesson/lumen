import AppKit
import React

/// A track list backed by a real `NSTableView`.
///
/// The React Native version of this list was unusable. Profiling a scroll
/// showed ~58% of main-thread samples inside `NSTextStorage`/`NSLayoutManager`
/// teardown and `_CFXNotificationRegistrarRemoveObservers`: every RN `<Text>`
/// allocates a TextKit stack, every `RCTView` with `onMouseEnter` registers a
/// notification observer on the enclosing clip view (`RCTView.m`), and
/// virtualizing the list only made rows churn faster. `NSTableView` recycles a
/// screenful of cells instead, so nothing is allocated while scrolling.
///
/// Row data arrives from JS in columnar form — parallel arrays rather than an
/// array of dictionaries — because the repeated keys dominate the payload and
/// the bridge would otherwise allocate a dictionary per row.

// MARK: - Model

struct LMTrackRow {
  let id: String
  let title: String
  let artist: String
  let album: String
  let duration: String
  let artworkURL: URL?
  var isFavorite: Bool
}

// MARK: - Artwork

/// Shared, size-keyed thumbnail cache.
///
/// Decoding full-size album art for hundreds of rows would exhaust memory, so
/// images are downsampled during decode via ImageIO. Requests go through
/// `URLSession.shared`, which uses the same cookie storage as the rest of the
/// app — cover URLs are session-authenticated.
final class LMArtworkLoader {
  static let shared = LMArtworkLoader()

  private let cache = NSCache<NSString, NSImage>()
  private let session = URLSession.shared

  private init() {
    cache.countLimit = 600
  }

  func cached(_ url: URL, side: CGFloat) -> NSImage? {
    cache.object(forKey: key(url, side))
  }

  /// Returns a cancellation handle the cell must call when it is reused.
  func load(
    _ url: URL,
    side: CGFloat,
    completion: @escaping (NSImage?) -> Void
  ) -> (() -> Void)? {
    if let hit = cached(url, side: side) {
      completion(hit)
      return nil
    }
    let pixels = side * (NSScreen.main?.backingScaleFactor ?? 2)
    let task = session.dataTask(with: url) { [weak self] data, _, _ in
      guard let self, let data, let image = LMArtworkLoader.downsample(data, to: pixels) else {
        DispatchQueue.main.async { completion(nil) }
        return
      }
      self.cache.setObject(image, forKey: self.key(url, side))
      DispatchQueue.main.async { completion(image) }
    }
    task.resume()
    return { task.cancel() }
  }

  private func key(_ url: URL, _ side: CGFloat) -> NSString {
    "\(url.absoluteString)|\(Int(side))" as NSString
  }

  private static func downsample(_ data: Data, to pixels: CGFloat) -> NSImage? {
    let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
      return nil
    }
    let options = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: pixels,
    ] as CFDictionary
    guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
    return NSImage(cgImage: thumb, size: NSSize(width: pixels, height: pixels))
  }
}

// MARK: - Cell

final class LMTrackCellView: NSTableCellView {
  private let artwork = NSImageView()
  private let playBadge = NSImageView()
  private let titleLabel = NSTextField(labelWithString: "")
  private let artistLabel = NSTextField(labelWithString: "")
  private let albumLabel = NSTextField(labelWithString: "")
  private let favoriteView = NSImageView()
  private let durationLabel = NSTextField(labelWithString: "")

  private var artworkURL: URL?
  private var cancelArtwork: (() -> Void)?

  var accentColor: NSColor = .controlAccentColor

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)

    artwork.imageScaling = .scaleProportionallyUpOrDown
    artwork.wantsLayer = true
    artwork.layer?.cornerRadius = 4
    artwork.layer?.masksToBounds = true
    artwork.layer?.backgroundColor = NSColor.quaternaryLabelColor.cgColor

    playBadge.image = NSImage(systemSymbolName: "play.fill", accessibilityDescription: nil)
    playBadge.contentTintColor = .white
    playBadge.wantsLayer = true
    playBadge.layer?.cornerRadius = 4
    playBadge.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.45).cgColor
    playBadge.imageScaling = .scaleProportionallyDown
    playBadge.isHidden = true

    titleLabel.font = .systemFont(ofSize: 13, weight: .medium)
    artistLabel.font = .systemFont(ofSize: 11)
    artistLabel.textColor = .secondaryLabelColor
    albumLabel.font = .systemFont(ofSize: 11)
    albumLabel.textColor = .secondaryLabelColor
    durationLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    durationLabel.textColor = .secondaryLabelColor
    durationLabel.alignment = .right

    // Single-line mode keeps TextKit from doing line-breaking work per row.
    for field in [titleLabel, artistLabel, albumLabel, durationLabel] {
      field.lineBreakMode = .byTruncatingTail
      field.cell?.usesSingleLineMode = true
      field.maximumNumberOfLines = 1
    }

    favoriteView.contentTintColor = .controlAccentColor
    favoriteView.imageScaling = .scaleProportionallyDown
    favoriteView.isHidden = true

    for view in [artwork, playBadge, titleLabel, artistLabel, albumLabel, favoriteView, durationLabel] {
      addSubview(view)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMTrackCellView is created programmatically only")
  }

  /// Laid out by frame rather than Auto Layout: rows are fixed height and there
  /// are a lot of them, so a constraint solve per cell is pure overhead.
  override func layout() {
    super.layout()
    let height = bounds.height
    let art = min(40, height - 12)
    let artY = (height - art) / 2

    artwork.frame = NSRect(x: 12, y: artY, width: art, height: art)
    playBadge.frame = artwork.frame

    let textX = artwork.frame.maxX + 12
    let durationWidth: CGFloat = 48
    let favoriteWidth: CGFloat = 22
    let rightEdge = bounds.width - 12
    durationLabel.frame = NSRect(
      x: rightEdge - durationWidth, y: (height - 14) / 2, width: durationWidth, height: 14)
    favoriteView.frame = NSRect(
      x: durationLabel.frame.minX - favoriteWidth - 6, y: (height - 14) / 2,
      width: favoriteWidth, height: 14)

    let available = favoriteView.frame.minX - textX - 16
    let albumWidth = max(0, available * 0.42)
    let titleWidth = max(0, available - albumWidth - 16)

    titleLabel.frame = NSRect(x: textX, y: height / 2, width: titleWidth, height: 17)
    artistLabel.frame = NSRect(x: textX, y: height / 2 - 17, width: titleWidth, height: 15)
    albumLabel.frame = NSRect(
      x: favoriteView.frame.minX - albumWidth - 8, y: (height - 15) / 2,
      width: albumWidth, height: 15)
  }

  func configure(with row: LMTrackRow, isNowPlaying: Bool) {
    titleLabel.stringValue = row.title
    artistLabel.stringValue = row.artist
    albumLabel.stringValue = row.album
    durationLabel.stringValue = row.duration
    titleLabel.textColor = isNowPlaying ? accentColor : .labelColor
    setFavorite(row.isFavorite)
    setArtwork(row.artworkURL)
  }

  func setFavorite(_ isFavorite: Bool) {
    favoriteView.isHidden = !isFavorite
    favoriteView.image = isFavorite
      ? NSImage(systemSymbolName: "heart.fill", accessibilityDescription: nil)
      : nil
  }

  private func setArtwork(_ url: URL?) {
    guard url != artworkURL else { return }
    cancelArtwork?()
    cancelArtwork = nil
    artworkURL = url
    artwork.image = nil
    guard let url else { return }

    if let hit = LMArtworkLoader.shared.cached(url, side: 40) {
      artwork.image = hit
      return
    }
    cancelArtwork = LMArtworkLoader.shared.load(url, side: 40) { [weak self] image in
      // Cancellation is best effort, so re-check identity before assigning:
      // a late response must not paint over the track now in this cell.
      guard let self, self.artworkURL == url else { return }
      self.artwork.image = image
      self.cancelArtwork = nil
    }
  }

  var isHovered: Bool = false {
    didSet {
      guard isHovered != oldValue else { return }
      playBadge.isHidden = !isHovered
    }
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    cancelArtwork?()
    cancelArtwork = nil
    artworkURL = nil
    artwork.image = nil
    playBadge.isHidden = true
    isHovered = false
  }
}

// MARK: - Row view

final class LMTrackRowView: NSTableRowView {
  var isHovered: Bool = false {
    didSet {
      guard isHovered != oldValue else { return }
      needsDisplay = true
    }
  }

  override func drawBackground(in dirtyRect: NSRect) {
    super.drawBackground(in: dirtyRect)
    guard isHovered, !isSelected else { return }
    NSColor.quaternaryLabelColor.withAlphaComponent(0.25).setFill()
    LMTrackRowView.pill(in: bounds).fill()
  }

  /// Drawn here rather than left to AppKit: the table sits on vibrancy with a
  /// clear background, and `.inset` style only draws its rounded selection pill
  /// for a table that paints an opaque background of its own. Same geometry as
  /// the hover tint above, so the two line up.
  override func drawSelection(in dirtyRect: NSRect) {
    guard selectionHighlightStyle != .none, isSelected else { return }
    let fill =
      isEmphasized
      ? NSColor.selectedContentBackgroundColor
      : NSColor.unemphasizedSelectedContentBackgroundColor
    fill.setFill()
    LMTrackRowView.pill(in: bounds).fill()
  }

  private static func pill(in bounds: NSRect) -> NSBezierPath {
    NSBezierPath(roundedRect: bounds.insetBy(dx: 8, dy: 1), xRadius: 6, yRadius: 6)
  }
}

// MARK: - Table

final class LMTrackTableView: NSTableView {
  var onHoverChange: ((Int, Int) -> Void)?
  var onContextMenu: ((Int, NSPoint) -> Void)?

  private var hoveredRow = -1
  private var boundsObserver: NSObjectProtocol?

  /// `menu(for:)` must return synchronously, so the menu itself is built one
  /// frame later by `LMContextMenuModule` — every menu in the app goes through
  /// that one path. Returning nil here suppresses AppKit's own menu.
  override func menu(for event: NSEvent) -> NSMenu? {
    let point = convert(event.locationInWindow, from: nil)
    let clicked = row(at: point)
    guard clicked >= 0 else { return super.menu(for: event) }

    // AppKit convention: right-clicking outside the selection retargets to the
    // clicked row; inside it, the selection is kept.
    if !selectedRowIndexes.contains(clicked) {
      selectRowIndexes(IndexSet(integer: clicked), byExtendingSelection: false)
    }

    // Report in React's coordinate space (top-left origin).
    let windowPoint = event.locationInWindow
    let contentHeight = window?.contentView?.bounds.height ?? 0
    onContextMenu?(clicked, NSPoint(x: windowPoint.x, y: contentHeight - windowPoint.y))
    return nil
  }

  /// Right-clicks stop here: the JS-built menu opening a frame later is the
  /// only one that should appear. Left to propagate, the event walks the
  /// responder chain to React Native's root view — which in debug builds pops
  /// the dev menu over ours.
  override func rightMouseDown(with event: NSEvent) {
    _ = menu(for: event)
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    // `.inVisibleRect` lets AppKit maintain the rect across scroll and resize,
    // so this is installed once. RN's own RCTView omits it and rebuilds every
    // tracking area on each bounds change, which is part of why the RN list
    // was slow.
    addTrackingArea(
      NSTrackingArea(
        rect: .zero,
        options: [.inVisibleRect, .activeInKeyWindow, .mouseEnteredAndExited, .mouseMoved],
        owner: self,
        userInfo: nil))
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if let boundsObserver {
      NotificationCenter.default.removeObserver(boundsObserver)
      self.boundsObserver = nil
    }
    guard let clipView = enclosingScrollView?.contentView else { return }
    clipView.postsBoundsChangedNotifications = true
    // One observer for the whole table. Scrolling under a stationary pointer
    // still changes which row is hovered.
    boundsObserver = NotificationCenter.default.addObserver(
      forName: NSView.boundsDidChangeNotification,
      object: clipView,
      queue: .main
    ) { [weak self] _ in
      self?.recomputeHover()
    }
  }

  deinit {
    if let boundsObserver { NotificationCenter.default.removeObserver(boundsObserver) }
  }

  override func mouseMoved(with event: NSEvent) {
    super.mouseMoved(with: event)
    updateHover(to: row(at: convert(event.locationInWindow, from: nil)))
  }

  override func mouseExited(with event: NSEvent) {
    super.mouseExited(with: event)
    updateHover(to: -1)
  }

  private func recomputeHover() {
    guard let window, window.isKeyWindow else { return updateHover(to: -1) }
    let point = convert(window.mouseLocationOutsideOfEventStream, from: nil)
    updateHover(to: bounds.contains(point) ? row(at: point) : -1)
  }

  private func updateHover(to newRow: Int) {
    guard newRow != hoveredRow else { return }
    let previous = hoveredRow
    hoveredRow = newRow
    onHoverChange?(previous, newRow)
  }

  /// Lets clicks reach controls inside a cell; NSTableView blocks most
  /// descendants from becoming first responder by default.
  override func validateProposedFirstResponder(
    _ responder: NSResponder, for event: NSEvent?
  ) -> Bool {
    return true
  }
}
