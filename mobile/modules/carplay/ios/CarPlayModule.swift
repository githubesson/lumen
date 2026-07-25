import CarPlay
import ExpoModulesCore
import UIKit

/// Attaches the window Expo creates in `AppDelegate` to UIKit's phone scene.
///
/// Adding the CarPlay scene role opts the whole app into scene lifecycle. Expo
/// still starts React Native in its app-delegate window, so that same window
/// must be adopted here instead of creating a second React root.
@objc(LumenPhoneSceneDelegate)
public final class LumenPhoneSceneDelegate: UIResponder, UIWindowSceneDelegate {
  public var window: UIWindow?

  public func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate,
      let appWindow = appDelegate.window ?? nil
    else {
      return
    }

    appWindow.windowScene = windowScene
    window = appWindow
    appWindow.makeKeyAndVisible()
  }

  /// Scene-based apps receive custom-scheme links here instead of through
  /// `UIApplicationDelegate`. Forward them to Expo's app delegate so the dev
  /// client and React Native linking subscribers keep their normal behavior.
  public func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate else { return }

    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [
        .openInPlace: context.options.openInPlace
      ]
      if let sourceApplication = context.options.sourceApplication {
        options[.sourceApplication] = sourceApplication
      }
      if let annotation = context.options.annotation {
        options[.annotation] = annotation
      }

      _ = appDelegate.application?(
        UIApplication.shared,
        open: context.url,
        options: options
      )
    }
  }

  public func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = UIApplication.shared.delegate?.application?(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }
}

/// How long a list selection may stay spinning in the car before we release it
/// ourselves. CarPlay shows an indeterminate spinner on the row until the
/// handler's completion fires; if JS is slow or crashed, the row would spin
/// forever without this.
private let selectionTimeout: TimeInterval = 10

/// One tile in a shelf. `id` is what `onSelect` carries when it's tapped.
struct ImageSpec: Record {
  @Field var id: String = ""
  @Field var imageUrl: String = ""
}

struct ListItemSpec: Record {
  @Field var id: String = ""
  @Field var text: String = ""
  @Field var detailText: String?
  @Field var isPlaying: Bool = false
  /// Dimmed and unselectable. Used for tracks that can't play right now —
  /// offline and not downloaded.
  @Field var enabled: Bool = true
  /// Set on rows that push another list, not on rows that start playback.
  @Field var showsDisclosureIndicator: Bool = false
  /// Artwork for the row: an https cover URL, or a `file://` URL for a
  /// downloaded track. Loaded asynchronously and applied when it arrives.
  @Field var imageUrl: String?
  /// SF Symbol drawn on the row: the whole image for a browse row, or the
  /// placeholder held until `imageUrl` loads.
  @Field var symbol: String?
  /// Non-empty turns the row into a shelf: covers side by side, each its own
  /// tap target. The row's own `id` still fires if the driver taps beside them.
  @Field var images: [ImageSpec] = []
}

struct ListSectionSpec: Record {
  @Field var header: String?
  @Field var headerSubtitle: String?
  /// Adds the chevron beside the header. Selecting it fires `onSelect` with
  /// this id — that's the "see all" affordance next to a shelf.
  @Field var headerButtonId: String?
  /// Single character for the fast-scroll index down the side of a long list.
  @Field var indexTitle: String?
  @Field var items: [ListItemSpec] = []
}

/// A button in the template's navigation bar.
struct NavButtonSpec: Record {
  @Field var id: String = ""
  @Field var symbol: String = ""
  @Field var enabled: Bool = true
}

struct ListTemplateSpec: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var sections: [ListSectionSpec] = []
  /// Shown in place of the list when it has no items — CarPlay renders an
  /// empty list as a blank screen otherwise.
  @Field var emptyTitle: String?
  @Field var emptyText: String?
  /// Spinner over the empty view while the first page is still loading, so a
  /// slow list reads as "coming" rather than "nothing here".
  @Field var loading: Bool = false
  /// Set when this template is one of the root tabs.
  @Field var tabTitle: String?
  @Field var tabSymbol: String?
  /// Trailing navigation-bar button — where the jump back to now playing lives,
  /// so it's reachable from every screen without spending a tab on it.
  @Field var navButton: NavButtonSpec?
}

struct NowPlayingButtonSpec: Record {
  /// Echoed back in `onNowPlayingButton`.
  @Field var id: String = ""
  @Field var symbol: String = ""
  /// Drawn with the selected treatment — how shuffle and repeat show they're on.
  @Field var selected: Bool = false
  @Field var enabled: Bool = true
}

struct NowPlayingConfigSpec: Record {
  @Field var buttons: [NowPlayingButtonSpec] = []
  @Field var upNextTitle: String?
  @Field var upNextEnabled: Bool = false
  @Field var albumArtistEnabled: Bool = false
}

/// Bridges the two now-playing template taps that arrive through a delegate
/// rather than a button handler.
final class CarPlayNowPlayingObserver: NSObject, CPNowPlayingTemplateObserver {
  var onUpNext: (() -> Void)?
  var onAlbumArtist: (() -> Void)?

  func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
    onUpNext?()
  }

  func nowPlayingTemplateAlbumArtistButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
    onAlbumArtist?()
  }
}

public class CarPlayModule: Module {
  /// Pending `CPListItem` completion handlers, keyed by the selection id handed
  /// to JS. Main-queue only.
  private var pendingSelections: [String: () -> Void] = [:]
  private var selectionCounter = 0

  /// Templates we've built, so `updateList` can refresh one in place without
  /// rebuilding the navigation stack. Cleared whenever a new root is installed,
  /// since that drops every template that came before it.
  private var templatesById: [String: CPListTemplate] = [:]

  /// The installed root, kept so a "see all" chevron can move to the tab that
  /// already holds the full list instead of pushing a second copy of it.
  private var tabBar: CPTabBarTemplate?

  private var nowPlayingObserver: CarPlayNowPlayingObserver?

  /// Whether iOS is currently letting the app read its own protected files.
  ///
  /// Mirrored rather than read from `UIApplication` on demand, because the
  /// getter is main-actor isolated and this is answered on the JS thread.
  /// Optimistic until `OnCreate` reads the real value: a car that never sees a
  /// locked phone must not be told to wait.
  private var protectedDataAvailable = true
  private var protectedDataObservers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("CarPlay")

    Events(
      "onConnect",
      "onDisconnect",
      "onSelect",
      "onNowPlayingButton",
      "onNowPlayingUpNext",
      "onNowPlayingAlbumArtist",
      "onProtectedDataAvailable"
    )

    /// CarPlay silently renders only the first `maximumItemCount` items (across
    /// all sections) and the first `maximumSectionCount` sections. The values
    /// are set by the connected head unit, so JS reads them rather than
    /// hardcoding a guess — building thousands of rows the car will drop is
    /// pure cost, and a truncated list should say so.
    // Int, not the API's UInt: only the signed type crosses to JS.
    Constant("maximumItemCount") { Int(CPListTemplate.maximumItemCount) }
    Constant("maximumSectionCount") { Int(CPListTemplate.maximumSectionCount) }
    /// Tabs beyond this are dropped by the system, so JS trims to fit.
    Constant("maximumTabCount") { CPTabBarTemplate.maximumTabCount }
    /// Covers in one shelf. The car may show fewer if the screen is narrow.
    Constant("maximumImageRowCount") { Int(CPMaximumNumberOfGridImages) }

    OnCreate {
      NSLog("LUMENCP: module OnCreate, isConnected=\(CarPlaySceneManager.shared.isConnected)")
      // Link-time reference: the scene delegate is instantiated by UIKit via
      // NSClassFromString, so nothing else in the binary refers to it and the
      // static linker would be free to drop the object file.
      _ = LumenCarPlaySceneDelegate.self

      CarPlaySceneManager.shared.onConnect = { [weak self] in
        self?.sendEvent("onConnect", [:])
      }
      CarPlaySceneManager.shared.onDisconnect = { [weak self] in
        self?.reset()
        self?.sendEvent("onDisconnect", [:])
      }

      self.installNowPlayingObserver()
      self.observeProtectedData()
    }

    OnDestroy {
      NSLog("LUMENCP: module OnDestroy")
      CarPlaySceneManager.shared.onConnect = nil
      CarPlaySceneManager.shared.onDisconnect = nil
      self.removeNowPlayingObserver()
      self.removeProtectedDataObservers()
      self.reset()
    }

    /// JS mounts after the scene may already have connected, so it reads the
    /// current state once instead of relying purely on `onConnect`.
    Function("isConnected") { () -> Bool in
      let value = CarPlaySceneManager.shared.isConnected
      NSLog("LUMENCP: js isConnected -> \(value)")
      return value
    }

    /// False between a cold boot and the phone's first unlock, when the app's
    /// cached session, its downloads and its persisted library are all
    /// unreadable. CarPlay is used against a locked phone as a matter of
    /// course, so this state is normal rather than exceptional.
    Function("isProtectedDataAvailable") { () -> Bool in
      self.protectedDataAvailable
    }

    AsyncFunction("setRootList") { (spec: ListTemplateSpec) in
      NSLog("LUMENCP: js setRootList id=\(spec.id) sections=\(spec.sections.count)")
      self.templatesById.removeAll()
      self.tabBar = nil
      let template = self.makeListTemplate(spec)
      CarPlaySceneManager.shared.setRootTemplate(template, animated: false)
    }.runOnQueue(.main)

    /// Installs the browse tabs along the top of the car screen. The tab bar is
    /// the root, so every list below is one tap from every other — the reason
    /// this exists instead of a menu the driver has to back out of.
    AsyncFunction("setRootTabs") { (specs: [ListTemplateSpec]) in
      NSLog("LUMENCP: js setRootTabs tabs=\(specs.count)")
      self.templatesById.removeAll()
      let templates = specs
        .prefix(CPTabBarTemplate.maximumTabCount)
        .map { self.makeListTemplate($0) }
      guard !templates.isEmpty else { return }
      let tabBar = CPTabBarTemplate(templates: Array(templates))
      self.tabBar = tabBar
      CarPlaySceneManager.shared.setRootTemplate(tabBar, animated: false)
    }.runOnQueue(.main)

    /// Moves to an installed tab. What a shelf's "see all" chevron does: the
    /// full list is already a tab, and pushing a copy of it would leave the
    /// driver somewhere they have to back out of.
    AsyncFunction("selectTab") { (templateId: String) in
      if #available(iOS 17.0, *) {
        guard
          let tabBar = self.tabBar,
          let template = self.templatesById[templateId],
          let index = tabBar.templates.firstIndex(of: template)
        else { return }
        tabBar.selectTemplate(at: index)
      }
    }.runOnQueue(.main)

    AsyncFunction("pushList") { (spec: ListTemplateSpec, animated: Bool) in
      let template = self.makeListTemplate(spec)
      CarPlaySceneManager.shared.interfaceController?
        .pushTemplate(template, animated: animated, completion: nil)
    }.runOnQueue(.main)

    /// Refreshes an already-built list (now-playing indicators, new tracks,
    /// a list that finished loading) without touching the navigation stack.
    /// Everything but the title, which CarPlay fixes at construction.
    AsyncFunction("updateList") { (spec: ListTemplateSpec) in
      guard let template = self.templatesById[spec.id] else { return }
      template.updateSections(self.makeSections(spec))
      self.applyEmptyState(spec, to: template)
    }.runOnQueue(.main)

    AsyncFunction("popTemplate") { (animated: Bool) in
      CarPlaySceneManager.shared.interfaceController?
        .popTemplate(animated: animated, completion: nil)
    }.runOnQueue(.main)

    AsyncFunction("popToRoot") { (animated: Bool) in
      CarPlaySceneManager.shared.interfaceController?
        .popToRootTemplate(animated: animated, completion: nil)
    }.runOnQueue(.main)

    /// The now-playing screen is a system template: it reads
    /// `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter`, which the player
    /// already feeds, so there is nothing to pass in here.
    ///
    /// It is a shared singleton, so pushing it while it is already in the stack
    /// would insert the same instance twice. Selecting a track from a list the
    /// user reached *through* now-playing does exactly that, so navigate back
    /// to it instead.
    AsyncFunction("pushNowPlaying") { (animated: Bool) in
      guard let controller = CarPlaySceneManager.shared.interfaceController else { return }
      let nowPlaying = CPNowPlayingTemplate.shared
      if controller.templates.contains(nowPlaying) {
        controller.pop(to: nowPlaying, animated: animated, completion: nil)
      } else {
        controller.pushTemplate(nowPlaying, animated: animated, completion: nil)
      }
    }.runOnQueue(.main)

    /// The row of buttons under the transport controls, plus the two system
    /// affordances beside them. Called again whenever the state they show
    /// changes — a selected shuffle button is how the car reports shuffle is on.
    AsyncFunction("configureNowPlaying") { (spec: NowPlayingConfigSpec) in
      let template = CPNowPlayingTemplate.shared
      template.updateNowPlayingButtons(spec.buttons.compactMap(self.makeNowPlayingButton))
      template.isUpNextButtonEnabled = spec.upNextEnabled
      if let upNextTitle = spec.upNextTitle {
        template.upNextTitle = upNextTitle
      }
      template.isAlbumArtistButtonEnabled = spec.albumArtistEnabled
    }.runOnQueue(.main)

    /// Releases the spinner on the row JS just handled.
    AsyncFunction("finishSelection") { (selectionId: String) in
      self.pendingSelections.removeValue(forKey: selectionId)?()
    }.runOnQueue(.main)
  }

  private func reset() {
    carPlayOnMain {
      self.pendingSelections.values.forEach { $0() }
      self.pendingSelections.removeAll()
      self.templatesById.removeAll()
      self.tabBar = nil
    }
  }

  private func installNowPlayingObserver() {
    carPlayOnMain {
      let observer = CarPlayNowPlayingObserver()
      observer.onUpNext = { [weak self] in
        self?.sendEvent("onNowPlayingUpNext", [:])
      }
      observer.onAlbumArtist = { [weak self] in
        self?.sendEvent("onNowPlayingAlbumArtist", [:])
      }
      CPNowPlayingTemplate.shared.add(observer)
      self.nowPlayingObserver = observer
    }
  }

  /// Tracks the file-protection state, and tells JS the moment the app's own
  /// files become readable.
  ///
  /// A car connecting before the phone's first unlock leaves the app unable to
  /// read its cached session — indistinguishable, from JS, from being signed
  /// out. Without this notification nothing would re-check once the driver
  /// unlocks, and the car would sit on the wrong screen for the whole drive.
  private func observeProtectedData() {
    carPlayOnMain {
      self.protectedDataAvailable = UIApplication.shared.isProtectedDataAvailable

      let center = NotificationCenter.default
      self.protectedDataObservers = [
        center.addObserver(
          forName: UIApplication.protectedDataDidBecomeAvailableNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          self?.protectedDataAvailable = true
          self?.sendEvent("onProtectedDataAvailable", [:])
        },
        center.addObserver(
          forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          self?.protectedDataAvailable = false
        },
      ]
    }
  }

  private func removeProtectedDataObservers() {
    let observers = protectedDataObservers
    protectedDataObservers = []
    guard !observers.isEmpty else { return }
    carPlayOnMain {
      for observer in observers {
        NotificationCenter.default.removeObserver(observer)
      }
    }
  }

  private func removeNowPlayingObserver() {
    guard let observer = nowPlayingObserver else { return }
    nowPlayingObserver = nil
    carPlayOnMain {
      CPNowPlayingTemplate.shared.remove(observer)
    }
  }

  private func makeNowPlayingButton(_ spec: NowPlayingButtonSpec) -> CPNowPlayingButton? {
    guard
      let image = CarPlayGlyph.image(
        named: spec.symbol,
        pointSize: CarPlayGlyph.nowPlayingPointSize
      )
    else { return nil }

    let buttonId = spec.id
    let button = CPNowPlayingImageButton(image: image) { [weak self] _ in
      self?.sendEvent("onNowPlayingButton", ["buttonId": buttonId])
    }
    button.isEnabled = spec.enabled
    button.isSelected = spec.selected
    return button
  }

  private func makeListTemplate(_ spec: ListTemplateSpec) -> CPListTemplate {
    let template = CPListTemplate(title: spec.title, sections: makeSections(spec))
    applyEmptyState(spec, to: template)

    if let tabTitle = spec.tabTitle {
      template.tabTitle = tabTitle
      if let symbol = spec.tabSymbol {
        template.tabImage = CarPlayGlyph.image(
          named: symbol,
          pointSize: CarPlayGlyph.tabPointSize
        )
      }
    }

    templatesById[spec.id] = template
    return template
  }

  private func applyEmptyState(_ spec: ListTemplateSpec, to template: CPListTemplate) {
    template.emptyViewTitleVariants = spec.emptyTitle.map { [$0] } ?? []
    template.emptyViewSubtitleVariants = spec.emptyText.map { [$0] } ?? []
    if #available(iOS 18.4, *) {
      template.showsSpinnerWhileEmpty = spec.loading
    }

    guard
      let navButton = spec.navButton,
      let image = CarPlayGlyph.image(
        named: navButton.symbol,
        pointSize: CarPlayGlyph.nowPlayingPointSize
      )
    else {
      template.trailingNavigationBarButtons = []
      return
    }

    let button = CPBarButton(image: image) { [weak self] _ in
      self?.emitSelection(templateId: spec.id, itemId: navButton.id)
    }
    button.isEnabled = navButton.enabled
    template.trailingNavigationBarButtons = [button]
  }

  private func makeSections(_ spec: ListTemplateSpec) -> [CPListSection] {
    spec.sections.map { makeSection($0, templateId: spec.id) }
  }

  private func makeSection(
    _ section: ListSectionSpec,
    templateId: String
  ) -> CPListSection {
    let items = section.items.map { makeItem($0, templateId: templateId) }

    guard let header = section.header else {
      return CPListSection(
        items: items,
        header: nil,
        sectionIndexTitle: section.indexTitle
      )
    }

    return CPListSection(
      items: items,
      header: header,
      headerSubtitle: section.headerSubtitle,
      headerImage: nil,
      headerButton: makeHeaderButton(section, templateId: templateId),
      sectionIndexTitle: section.indexTitle
    )
  }

  private func makeHeaderButton(
    _ section: ListSectionSpec,
    templateId: String
  ) -> CPButton? {
    guard
      let buttonId = section.headerButtonId,
      let image = CarPlayGlyph.image(named: "chevron.right", pointSize: 18)
    else { return nil }

    return CPButton(image: image) { [weak self] _ in
      self?.emitSelection(templateId: templateId, itemId: buttonId)
    }
  }

  private func makeItem(
    _ spec: ListItemSpec,
    templateId: String
  ) -> any CPListTemplateItem {
    if !spec.images.isEmpty {
      return makeImageRow(spec, templateId: templateId)
    }

    let item = CPListItem(text: spec.text, detailText: spec.detailText)
    item.isPlaying = spec.isPlaying
    item.isEnabled = spec.enabled
    item.accessoryType = spec.showsDisclosureIndicator ? .disclosureIndicator : .none
    applyImage(spec, to: item)

    item.handler = { [weak self] _, completion in
      self?.beginSelection(templateId: templateId, itemId: spec.id, completion: completion)
        ?? completion()
    }

    return item
  }

  /// A shelf: covers side by side, each opening what it shows.
  ///
  /// The row has to be built complete, so it goes out with placeholder tiles
  /// and swaps each cover in as it loads — see `CarPlayImageRowArtwork`, which
  /// the row itself retains.
  private func makeImageRow(
    _ spec: ListItemSpec,
    templateId: String
  ) -> CPListImageRowItem {
    let loader = CarPlayImageLoader.shared
    let size = imageRowImageSize()
    let scale = CarPlaySceneManager.shared.displayScale
    let tiles = Array(spec.images.prefix(Int(CPMaximumNumberOfGridImages)))
    let cached = tiles.map { tile in
      tile.imageUrl.isEmpty
        ? nil : loader.cachedImage(url: tile.imageUrl, size: size, scale: scale)
    }

    let placeholder = loader.placeholder(size: size, scale: scale)
    let row = makeImageRowItem(
      text: spec.text,
      images: cached.map { $0 ?? placeholder }
    )
    let artwork = CarPlayImageRowArtwork(
      row: row,
      images: cached.map { $0 ?? placeholder }
    )
    row.userInfo = artwork

    for (index, tile) in tiles.enumerated() where cached[index] == nil {
      guard !tile.imageUrl.isEmpty else { continue }
      loader.loadImage(url: tile.imageUrl, size: size, scale: scale) {
        [weak artwork] image in
        guard let image else { return }
        artwork?.replace(image, at: index)
      }
    }

    row.isEnabled = spec.enabled
    row.handler = { [weak self] _, completion in
      self?.beginSelection(templateId: templateId, itemId: spec.id, completion: completion)
        ?? completion()
    }
    row.listImageRowHandler = { [weak self] _, index, completion in
      let itemId = index < tiles.count ? tiles[index].id : spec.id
      self?.beginSelection(templateId: templateId, itemId: itemId, completion: completion)
        ?? completion()
    }

    return row
  }

  private func makeImageRowItem(text: String, images: [UIImage]) -> CPListImageRowItem {
    if #available(iOS 26.0, *) {
      return CPListImageRowItem(
        text: text.isEmpty ? nil : text,
        gridElements: images.map { CPListImageRowItemGridElement(image: $0) },
        allowsMultipleLines: false
      )
    }
    return Self.legacyImageRowItem(text: text, images: images)
  }

  private func imageRowImageSize() -> CGSize {
    if #available(iOS 26.0, *) {
      return CPListImageRowItemElement.maximumImageSize
    }
    return Self.legacyImageRowImageSize()
  }

  /// iOS 26 replaced grid images with elements; the old API still draws
  /// everywhere below it.
  @available(iOS, deprecated: 26.0)
  private static func legacyImageRowItem(
    text: String,
    images: [UIImage]
  ) -> CPListImageRowItem {
    CPListImageRowItem(text: text, images: images)
  }

  @available(iOS, deprecated: 26.0)
  private static func legacyImageRowImageSize() -> CGSize {
    CPListImageRowItem.maximumImageSize
  }

  /// Hands the selection to JS and holds the row's spinner until it answers.
  private func beginSelection(
    templateId: String,
    itemId: String,
    completion: @escaping () -> Void
  ) {
    selectionCounter += 1
    let selectionId = "selection-\(selectionCounter)"
    pendingSelections[selectionId] = completion

    sendEvent("onSelect", [
      "selectionId": selectionId,
      "templateId": templateId,
      "itemId": itemId,
    ])

    DispatchQueue.main.asyncAfter(deadline: .now() + selectionTimeout) { [weak self] in
      self?.pendingSelections.removeValue(forKey: selectionId)?()
    }
  }

  /// Same event from a button, which CarPlay draws without a spinner and so
  /// hands us nothing to release. The empty selection id finishes as a no-op.
  private func emitSelection(templateId: String, itemId: String) {
    sendEvent("onSelect", [
      "selectionId": "",
      "templateId": templateId,
      "itemId": itemId,
    ])
  }

  /// Draws the row's symbol immediately so the list has its final layout, then
  /// swaps in the cover once it loads. The item is captured weakly: rows are
  /// routinely thrown away by a refresh while their artwork is still in flight.
  private func applyImage(_ spec: ListItemSpec, to item: CPListItem) {
    let glyph = spec.symbol.flatMap {
      CarPlayGlyph.image(named: $0, pointSize: CarPlayGlyph.listPointSize)
    }

    guard let imageUrl = spec.imageUrl else {
      if let glyph { item.setImage(glyph) }
      return
    }

    let size = CPListItem.maximumImageSize
    let scale = CarPlaySceneManager.shared.displayScale

    if let cached = CarPlayImageLoader.shared.cachedImage(url: imageUrl, size: size, scale: scale) {
      item.setImage(cached)
      return
    }

    if let glyph { item.setImage(glyph) }
    CarPlayImageLoader.shared.loadImage(url: imageUrl, size: size, scale: scale) {
      [weak item] image in
      guard let item, let image else { return }
      item.setImage(image)
    }
  }
}
