import CarPlay
import UIKit

/// Hops to the main thread for CarPlay work.
///
/// Every CarPlay type is main-actor isolated. Going through this helper rather
/// than `DispatchQueue.main.async` at each call site keeps the work closure a
/// plain, non-`Sendable` function, so the compiler doesn't treat its body as a
/// concurrent context — which is what lets the calls inside it type-check.
func carPlayOnMain(_ work: @escaping () -> Void) {
  if Thread.isMainThread {
    work()
  } else {
    DispatchQueue.main.async(execute: work)
  }
}

/// Loads and caches the artwork CarPlay draws on list rows.
///
/// A list is handed to the head unit long before its covers can be fetched, so
/// rows go out with whatever is already cached and each missing image is
/// applied to its live `CPListItem` when it lands — assigning an image reloads
/// just that row, without disturbing the list or the navigation stack.
///
/// Covers come from the app's own auth-gated endpoints. `URLSession.shared`
/// shares the cookie storage React Native's `fetch` filled at sign-in, so no
/// credential has to cross the bridge. Downloaded tracks pass a `file://` URL
/// instead and never touch the network.
final class CarPlayImageLoader {
  static let shared = CarPlayImageLoader()

  /// Decoded, already-downscaled images keyed by source and target geometry.
  /// Bounded: a long browse session in the car must not grow without limit.
  private let cache = NSCache<NSString, UIImage>()
  /// Reading downloaded covers off disk; network loads have their own queue.
  private let ioQueue = DispatchQueue(
    label: "com.lumen.carplay.artwork",
    qos: .userInitiated,
    attributes: .concurrent
  )
  private let lock = NSLock()
  /// Callbacks waiting on a load already in flight, so the ten tracks of one
  /// album cause a single request for their shared cover.
  private var waiting: [String: [(UIImage?) -> Void]] = [:]

  private init() {
    cache.countLimit = 400
  }

  /// Synchronous hit, so a row that has been drawn before is never imageless.
  func cachedImage(url: String, size: CGSize, scale: CGFloat) -> UIImage? {
    cache.object(forKey: cacheKey(url, size, scale) as NSString)
  }

  /// Fetches `url`, then calls `completion` on the main thread. Never calls
  /// back for a load it joined to an in-flight request that later fails, and
  /// passes `nil` rather than throwing — artwork is decoration, a row without
  /// it is still usable.
  func loadImage(
    url: String,
    size: CGSize,
    scale: CGFloat,
    completion: @escaping (UIImage?) -> Void
  ) {
    let key = cacheKey(url, size, scale)

    if let cached = cache.object(forKey: key as NSString) {
      carPlayOnMain { completion(cached) }
      return
    }

    lock.lock()
    if waiting[key] != nil {
      waiting[key]?.append(completion)
      lock.unlock()
      return
    }
    waiting[key] = [completion]
    lock.unlock()

    fetchData(url) { [weak self] data in
      guard let self else { return }
      let image = data
        .flatMap { UIImage(data: $0) }
        .flatMap { $0.carPlayThumbnail(size: size, scale: scale) }
      if let image {
        self.cache.setObject(image, forKey: key as NSString)
      }
      self.deliver(image, for: key)
    }
  }

  /// Neutral tile drawn where a cover hasn't arrived yet, so a shelf has its
  /// final shape on the first frame instead of growing under the driver.
  func placeholder(size: CGSize, scale: CGFloat) -> UIImage {
    let key = cacheKey("lumen://placeholder", size, scale) as NSString
    if let cached = cache.object(forKey: key) { return cached }

    let format = UIGraphicsImageRendererFormat.default()
    format.scale = max(1, scale)
    format.opaque = false

    let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      let bounds = CGRect(origin: .zero, size: size)
      // Fixed neutral rather than a system fill: the car picks its own light
      // or dark theme, and this reads on both.
      UIColor(white: 0.5, alpha: 0.22).setFill()
      UIBezierPath(
        roundedRect: bounds,
        cornerRadius: min(size.width, size.height) * 0.16
      ).fill()

      guard
        let glyph = CarPlayGlyph.image(
          named: "music.note",
          pointSize: min(size.width, size.height) * 0.4
        )
      else { return }

      let tinted = glyph.withTintColor(
        UIColor(white: 1, alpha: 0.45),
        renderingMode: .alwaysOriginal
      )
      tinted.draw(
        in: CGRect(
          x: bounds.midX - tinted.size.width / 2,
          y: bounds.midY - tinted.size.height / 2,
          width: tinted.size.width,
          height: tinted.size.height
        )
      )
    }

    cache.setObject(image, forKey: key)
    return image
  }

  func removeAll() {
    cache.removeAllObjects()
  }

  private func deliver(_ image: UIImage?, for key: String) {
    lock.lock()
    let completions = waiting.removeValue(forKey: key) ?? []
    lock.unlock()

    guard !completions.isEmpty else { return }
    carPlayOnMain {
      for completion in completions {
        completion(image)
      }
    }
  }

  private func fetchData(_ url: String, completion: @escaping (Data?) -> Void) {
    guard let parsed = URL(string: url) else {
      completion(nil)
      return
    }

    if parsed.isFileURL {
      ioQueue.async { completion(try? Data(contentsOf: parsed)) }
      return
    }

    var request = URLRequest(url: parsed)
    // Short: a cover that hasn't arrived by then is one the driver has already
    // scrolled past, and the row reads fine without it.
    request.timeoutInterval = 15
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 200
      completion((200..<300).contains(status) ? data : nil)
    }.resume()
  }

  private func cacheKey(_ url: String, _ size: CGSize, _ scale: CGFloat) -> String {
    "\(url)|\(Int(size.width))x\(Int(size.height))@\(scale)"
  }
}

private extension UIImage {
  /// Aspect-fill crop to `size` with rounded corners, rendered at the car
  /// screen's scale.
  ///
  /// CarPlay resizes oversized images itself, but doing it once here keeps a
  /// 1000px cover from being rescaled into a 60pt row on every draw — and the
  /// corner radius is the difference between artwork that looks placed and
  /// artwork that looks pasted.
  func carPlayThumbnail(size: CGSize, scale: CGFloat) -> UIImage? {
    guard size.width > 0, size.height > 0, self.size.width > 0, self.size.height > 0
    else { return nil }

    let format = UIGraphicsImageRendererFormat.default()
    format.scale = max(1, scale)
    format.opaque = false

    let fill = max(size.width / self.size.width, size.height / self.size.height)
    let drawn = CGSize(width: self.size.width * fill, height: self.size.height * fill)
    let origin = CGPoint(
      x: (size.width - drawn.width) / 2,
      y: (size.height - drawn.height) / 2
    )

    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      UIBezierPath(
        roundedRect: CGRect(origin: .zero, size: size),
        cornerRadius: min(size.width, size.height) * 0.16
      ).addClip()
      draw(in: CGRect(origin: origin, size: drawn))
    }
  }
}

/// Keeps a shelf's covers in sync as they arrive.
///
/// A row of artwork has to be handed to CarPlay complete, so it goes out with
/// placeholders and swaps each tile in as it loads. Held by the row itself
/// through `userInfo`, so it lives exactly as long as what it updates.
final class CarPlayImageRowArtwork {
  private weak var row: CPListImageRowItem?
  private var images: [UIImage]

  init(row: CPListImageRowItem, images: [UIImage]) {
    self.row = row
    self.images = images
  }

  func replace(_ image: UIImage, at index: Int) {
    guard index >= 0, index < images.count else { return }
    images[index] = image
    apply()
  }

  private func apply() {
    guard let row else { return }
    if #available(iOS 26.0, *) {
      row.elements = images.map { CPListImageRowItemGridElement(image: $0) }
    } else {
      Self.legacyUpdate(row, images)
    }
  }

  /// iOS 26 replaced the grid-image API with elements; the old one still draws
  /// everywhere below it.
  @available(iOS, deprecated: 26.0)
  private static func legacyUpdate(_ row: CPListImageRowItem, _ images: [UIImage]) {
    row.update(images)
  }
}

/// SF Symbols for rows, tabs and now-playing buttons.
///
/// Rendered as template images so the head unit recolors them for the car's
/// light or dark theme instead of us guessing at it.
enum CarPlayGlyph {
  /// Leading image on a browse row, and the placeholder a track row shows
  /// while its cover loads.
  static let listPointSize: CGFloat = 22
  static let tabPointSize: CGFloat = 24
  static let nowPlayingPointSize: CGFloat = 20

  static func image(
    named name: String,
    pointSize: CGFloat,
    weight: UIImage.SymbolWeight = .semibold
  ) -> UIImage? {
    let configuration = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
    return UIImage(systemName: name, withConfiguration: configuration)?
      .withRenderingMode(.alwaysTemplate)
  }
}
