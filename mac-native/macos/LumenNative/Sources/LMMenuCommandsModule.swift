import AppKit
import React

/// Main-menu integration.
///
/// Menu items are the Mac-native home for shortcuts: they are discoverable,
/// they show their key equivalent, and AppKit routes the keystroke regardless of
/// which view has focus. React Native's own key handling on macOS is
/// focus-dependent, so nothing here goes through JS key events.
@objc(LMMenuCommandsModule)
final class LMMenuCommandsModule: RCTEventEmitter {
  private static weak var shared: LMMenuCommandsModule?

  private var hasListeners = false
  private var spaceMonitor: Any?
  private var playPauseItem: NSMenuItem?
  private var shuffleItem: NSMenuItem?
  private var repeatItem: NSMenuItem?
  private var transportItems: [NSMenuItem] = []

  override var methodQueue: DispatchQueue { .main }
  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String] { ["menuCommand", "escape"] }

  override init() {
    super.init()
    LMMenuCommandsModule.shared = self
    DispatchQueue.main.async { [weak self] in
      self?.buildMenus()
      self?.installSpaceMonitor()
    }
  }

  deinit {
    if let spaceMonitor {
      NSEvent.removeMonitor(spaceMonitor)
    }
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  private func emit(_ id: String) {
    guard hasListeners else { return }
    sendEvent(withName: "menuCommand", body: ["id": id])
  }

  @objc private func handleMenuItem(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    emit(id)
  }

  private func item(
    _ title: String,
    _ id: String,
    key: String = "",
    modifiers: NSEvent.ModifierFlags = .command
  ) -> NSMenuItem {
    let menuItem = NSMenuItem(
      title: title,
      action: #selector(handleMenuItem(_:)),
      keyEquivalent: key
    )
    menuItem.target = self
    menuItem.representedObject = id
    menuItem.keyEquivalentModifierMask = key.isEmpty ? [] : modifiers
    return menuItem
  }

  /// The React Native template ships AppKit's document-app menu bar: New, Open,
  /// Save, Page Setup, Font, a Find submenu, Speech. None of it does anything in
  /// a music client, and worse, those items own key equivalents — ⌘N and ⌘F
  /// would be swallowed by dead menu items before reaching ours, because AppKit
  /// resolves the first match in menu order.
  private func pruneTemplateMenus() {
    guard let mainMenu = NSApp.mainMenu else { return }

    func menu(titled title: String) -> NSMenu? {
      mainMenu.items.first { $0.title == title }?.submenu
    }

    if let file = menu(titled: "File") {
      let keep: Set<String> = ["Close"]
      for item in file.items where !keep.contains(item.title) {
        file.removeItem(item)
      }
    }

    if let edit = menu(titled: "Edit") {
      let drop: Set<String> = [
        "Find",
        "Spelling and Grammar",
        "Substitutions",
        "Transformations",
        "Speech",
        "Paste and Match Style",
      ]
      for item in edit.items where drop.contains(item.title) {
        edit.removeItem(item)
      }
    }

    // Nothing in this app is rich text.
    if let format = mainMenu.items.first(where: { $0.title == "Format" }) {
      mainMenu.removeItem(format)
    }

    // macOS puts Settings in the app menu, so adopt the template's inert
    // Preferences item instead of adding a second one elsewhere — otherwise it
    // keeps ⌘, and shadows ours, since AppKit takes the first match in menu
    // order and the app menu is always first.
    if let appMenu = mainMenu.items.first?.submenu,
       let preferences = appMenu.items.first(where: {
         $0.title == "Preferences…" || $0.title == "Settings…"
       }) {
      preferences.title = "Settings…"
      preferences.target = self
      preferences.action = #selector(handleMenuItem(_:))
      preferences.representedObject = "goSettings"
      preferences.keyEquivalent = ","
      preferences.keyEquivalentModifierMask = .command
    }

    if let view = menu(titled: "View") {
      let keep: Set<String> = ["Enter Full Screen", "Toggle Full Screen"]
      for item in view.items where !keep.contains(item.title) && !item.isSeparatorItem {
        view.removeItem(item)
      }
    }
  }

  private func buildMenus() {
    pruneTemplateMenus()
    guard let mainMenu = NSApp.mainMenu else { return }

    // ---- Playback -------------------------------------------------------
    let playback = NSMenu(title: "Playback")
    // Without this AppKit enables any item whose target implements the action,
    // which would keep the transport live with no track loaded.
    playback.autoenablesItems = false

    // Space gets no key equivalent: AppKit would consume it before a focused
    // text field ever saw it, so typing a space in search would toggle
    // playback. The local event monitor below handles it conditionally.
    let playPause = item("Play", "playPause")
    playPause.isEnabled = false
    playPauseItem = playPause
    playback.addItem(playPause)

    let next = item("Next", "next", key: String(UnicodeScalar(NSRightArrowFunctionKey)!))
    let previous = item(
      "Previous",
      "previous",
      key: String(UnicodeScalar(NSLeftArrowFunctionKey)!)
    )
    playback.addItem(next)
    playback.addItem(previous)
    playback.addItem(.separator())

    let shuffle = item("Shuffle", "shuffle", key: "s", modifiers: [.command, .option])
    let repeatItem = item("Repeat", "repeat", key: "r", modifiers: [.command, .option])
    self.shuffleItem = shuffle
    self.repeatItem = repeatItem
    playback.addItem(shuffle)
    playback.addItem(repeatItem)
    playback.addItem(.separator())

    let volumeUp = item("Volume Up", "volumeUp", key: String(UnicodeScalar(NSUpArrowFunctionKey)!))
    let volumeDown = item(
      "Volume Down",
      "volumeDown",
      key: String(UnicodeScalar(NSDownArrowFunctionKey)!)
    )
    let mute = item("Mute", "mute", key: "m", modifiers: [.command, .option])
    playback.addItem(volumeUp)
    playback.addItem(volumeDown)
    playback.addItem(mute)

    transportItems = [next, previous, shuffle, repeatItem, volumeUp, volumeDown, mute]
    for menuItem in transportItems { menuItem.isEnabled = false }

    let playbackItem = NSMenuItem()
    playbackItem.submenu = playback
    playbackItem.title = "Playback"

    // ---- Go -------------------------------------------------------------
    let go = NSMenu(title: "Go")
    go.autoenablesItems = false
    go.addItem(item("Home", "goHome", key: "1"))
    go.addItem(item("Browse", "goBrowse", key: "2"))
    go.addItem(item("Favorites", "goFavorites", key: "3"))
    go.addItem(item("Playlists", "goPlaylists", key: "4"))
    // Settings deliberately absent: it lives in the app menu, where macOS users
    // look for it.
    go.addItem(.separator())
    go.addItem(item("Now Playing", "toggleNowPlaying", key: "n"))
    go.addItem(item("Back", "back", key: "["))
    go.addItem(.separator())
    go.addItem(item("Search", "search", key: "f"))

    let goItem = NSMenuItem()
    goItem.submenu = go
    goItem.title = "Go"

    // Insert before the trailing Window/Help menus so the order reads
    // App, File, Edit, Playback, Go, …, Window, Help.
    let insertIndex = max(0, mainMenu.numberOfItems - 2)
    mainMenu.insertItem(playbackItem, at: insertIndex)
    mainMenu.insertItem(goItem, at: insertIndex + 1)
  }

  /// Space toggles playback, except while typing. A menu key equivalent cannot
  /// express that condition, so the keystroke is inspected before the responder
  /// chain sees it and passed through whenever a text control is first
  /// responder.
  private func installSpaceMonitor() {
    spaceMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self else { return event }

      // Escape dismisses the Now Playing panel. JS decides whether anything is
      // open; if not it ignores the event and Escape keeps its normal meaning.
      if event.keyCode == 53 {
        guard self.hasListeners else { return event }
        self.sendEvent(withName: "escape", body: [:])
        return event
      }

      guard event.keyCode == 49 else { return event }
      if !event.modifierFlags.intersection([.command, .option, .control]).isEmpty {
        return event
      }
      if self.isEditingText { return event }
      self.emit("playPause")
      return nil
    }
  }

  /// True when a text control owns the keystroke. AppKit gives a focused field
  /// its own field editor, so the first responder is that `NSTextView` rather
  /// than the field itself.
  private var isEditingText: Bool {
    let responder = NSApp.keyWindow?.firstResponder
    if responder is NSTextView || responder is NSTextField { return true }
    if let view = responder as? NSView, view.isKind(of: NSTextView.self) { return true }
    return false
  }

  /// Keeps the menu honest: the title flips between Play and Pause, transport
  /// items disable with no track loaded, and the toggles show a checkmark.
  @objc(setPlaybackState:)
  func setPlaybackState(state: NSDictionary) {
    let hasTrack = state["hasTrack"] as? Bool ?? false
    let isPlaying = state["isPlaying"] as? Bool ?? false
    let shuffle = state["shuffle"] as? Bool ?? false
    let repeatMode = state["repeat"] as? String ?? "off"

    playPauseItem?.title = isPlaying ? "Pause" : "Play"
    playPauseItem?.isEnabled = hasTrack
    for menuItem in transportItems { menuItem.isEnabled = hasTrack }

    shuffleItem?.state = shuffle ? .on : .off
    repeatItem?.state = repeatMode == "off" ? .off : .on
    repeatItem?.title = repeatMode == "one" ? "Repeat One" : "Repeat"
  }
}
