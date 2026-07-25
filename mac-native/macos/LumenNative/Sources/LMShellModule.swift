import AppKit
import React

/// Installs and drives the window's native shell: an `NSSplitViewController`
/// whose sidebar is a real source-list `NSOutlineView` and whose content pane
/// hosts React Native.
///
/// The split view is built the first time JS supplies sidebar contents rather
/// than at launch, so the ordering is explicit: React Native's own root view
/// controller already exists by then and simply becomes the content item.
@objc(LMShellModule)
final class LMShellModule: RCTEventEmitter {
  private var hasListeners = false
  private weak var splitViewController: NSSplitViewController?
  private weak var sidebarViewController: LMSidebarViewController?
  /// Sidebar state to return to when the expanded player closes.
  private var sidebarWasCollapsed = false
  /// Last visible sidebar width, so the content's final frame is known before
  /// the expand animation starts.
  private var lastSidebarWidth: CGFloat = 208
  private var appearanceObservation: NSKeyValueObservation?

  override var methodQueue: DispatchQueue { .main }
  override static func requiresMainQueueSetup() -> Bool { true }

  private let toolbarController = LMToolbarController()

  override func supportedEvents() -> [String] {
    ["sidebarSelect", "toolbarSearch", "toolbarSegment", "toolbarBack", "appearanceChange"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  /// The resolved light/dark appearance, reported to JS.
  ///
  /// React Native's own `useColorScheme` is not usable here: `RCTAppearance`
  /// resolves the scheme once from the key window, and at the point the bridge
  /// starts there is no key window yet — so it latches onto light and stays
  /// there for the life of the process, no matter what the system is set to.
  /// That is what left the React-drawn content pane in the light palette
  /// underneath a dark AppKit sidebar.
  override func constantsToExport() -> [AnyHashable: Any]! {
    ["initialScheme": LMShellModule.currentScheme()]
  }

  private static func currentScheme() -> String {
    let matched = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])
    return matched == .darkAqua ? "dark" : "light"
  }

  override init() {
    super.init()
    // Fires for both the system changing underneath the app and the app's own
    // `setAppearance`, so JS never has to guess which one it was.
    appearanceObservation = NSApp.observe(\.effectiveAppearance) { [weak self] _, _ in
      guard let self, self.hasListeners else { return }
      self.sendEvent(
        withName: "appearanceChange", body: ["scheme": LMShellModule.currentScheme()])
    }
  }

  private func installIfNeeded() -> LMSidebarViewController? {
    if let sidebarViewController { return sidebarViewController }
    guard let window = NSApp.windows.first(where: { $0.contentViewController != nil }),
          let contentViewController = window.contentViewController
    else { return nil }

    let sidebar = LMSidebarViewController()
    sidebar.onSelect = { [weak self] id in
      guard let self, self.hasListeners else { return }
      self.sendEvent(withName: "sidebarSelect", body: ["id": id])
    }

    let split = NSSplitViewController()
    // `sidebarWithViewController:` is what supplies the sidebar's inset
    // floating shape, collapse behaviour and toolbar integration.
    // `allowsFullHeightLayout` (default true) plus the window's
    // `.fullSizeContentView` style is what runs it up behind the titlebar, so
    // the traffic lights float over it.
    let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
    sidebarItem.minimumThickness = 200
    sidebarItem.maximumThickness = 320
    sidebarItem.canCollapse = true
    sidebarItem.allowsFullHeightLayout = true

    // Content deliberately fills the pane rather than the safe area: the glass
    // toolbar tints itself from whatever is behind it, so insetting the content
    // below the toolbar left it sampling the empty window background and
    // rendering light over a dark app. Screens leave room for it in their own
    // padding instead.
    let contentItem = NSSplitViewItem(
      viewController: LMContentViewController(child: contentViewController))
    contentItem.minimumThickness = 480

    split.addSplitViewItem(sidebarItem)
    split.addSplitViewItem(contentItem)

    // The split view rides on one shared backdrop rather than becoming the
    // content view controller itself: with per-pane backgrounds the sidebar
    // pane and the content pane rendered as two visibly different surfaces,
    // with a hard seam at the divider. AppKit still finds the nested split
    // view for the toolbar's sidebar toggle and tracking separator.
    let root = NSViewController()
    root.view = LMWindowBackdropView()
    root.addChild(split)
    split.view.frame = root.view.bounds
    split.view.autoresizingMask = [.width, .height]
    root.view.addSubview(split.view)

    window.contentViewController = root
    splitViewController = split
    sidebarViewController = sidebar

    toolbarController.onSearch = { [weak self] text in
      guard let self, self.hasListeners else { return }
      self.sendEvent(withName: "toolbarSearch", body: ["text": text])
    }
    toolbarController.onSegment = { [weak self] index in
      guard let self, self.hasListeners else { return }
      self.sendEvent(withName: "toolbarSegment", body: ["index": index])
    }
    toolbarController.onBack = { [weak self] in
      guard let self, self.hasListeners else { return }
      self.sendEvent(withName: "toolbarBack", body: [:])
    }
    toolbarController.attach(to: window)

    return sidebar
  }

  /// Reconfigure the toolbar for the screen now showing.
  @objc(setToolbar:)
  func setToolbar(config: NSDictionary) {
    _ = installIfNeeded()
    toolbarController.configure(
      showsBack: config["showsBack"] as? Bool ?? false,
      showsSearch: config["showsSearch"] as? Bool ?? false,
      searchPlaceholder: config["searchPlaceholder"] as? String ?? "Search",
      segments: config["segments"] as? [String] ?? [],
      selectedSegment: config["selectedSegment"] as? Int ?? 0
    )
    if let text = config["searchText"] as? String {
      toolbarController.setSearchText(text)
    }
  }

  @objc(focusSearch)
  func focusSearch() {
    toolbarController.focusSearch()
  }

  /// Hand the whole window over to the expanded player.
  ///
  /// The toolbar and sidebar belong to the window, not to React, so the player
  /// cannot simply draw over them — it has to ask for them to go away.
  @objc(setImmersive:)
  func setImmersive(immersive: Bool) {
    DispatchQueue.main.async { [weak self] in
      guard let self, let split = self.splitViewController else { return }
      split.view.window?.toolbar?.isVisible = !immersive

      guard let sidebarItem = split.splitViewItems.first else { return }
      if immersive {
        // Leaving the player restores whatever the sidebar was before, so a
        // window the user had already collapsed does not reopen itself.
        self.sidebarWasCollapsed = sidebarItem.isCollapsed
        let width = sidebarItem.viewController.view.frame.width
        if width > 1 { self.lastSidebarWidth = width }
      }
      let collapsed = immersive ? true : self.sidebarWasCollapsed
      guard sidebarItem.isCollapsed != collapsed else { return }
      let content = split.splitViewItems.last?.viewController as? LMContentViewController

      // Freeze the React root at its final frame before animating: the
      // animated pane resize would otherwise re-lay-out the whole JS tree on
      // every frame, which made the slide stutter (and, before the
      // react-native-macos `nativeProps_DEPRECATED` patch, crash). Pinned,
      // the root re-lays-out exactly once — up front — and the sidebar then
      // slides over or away from settled content.
      if let host = split.view.window?.contentView {
        let bounds = host.bounds
        let target =
          collapsed
          ? bounds
          : NSRect(
            x: self.lastSidebarWidth, y: 0,
            width: bounds.width - self.lastSidebarWidth, height: bounds.height)
        content?.pinnedWindowFrame = host.convert(target, to: nil)
        content?.syncChildFrame()
      }

      NSAnimationContext.runAnimationGroup(
        { context in
          context.duration = 0.24
          context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
          sidebarItem.animator().isCollapsed = collapsed
        },
        completionHandler: {
          content?.pinnedWindowFrame = nil
          content?.syncChildFrame()
        })
    }
  }

  /// Pin the app's appearance so AppKit-drawn chrome matches the JS theme.
  ///
  /// Without this the toolbar, sidebar and menus follow the system while the
  /// React-drawn content follows the app's own setting — which showed up as a
  /// light toolbar above a dark window. `nil` hands control back to the system,
  /// which is what the "System" theme option means.
  @objc(setAppearance:)
  func setAppearance(scheme: NSString) {
    switch scheme as String {
    case "dark":
      NSApp.appearance = NSAppearance(named: .darkAqua)
    case "light":
      NSApp.appearance = NSAppearance(named: .aqua)
    default:
      NSApp.appearance = nil
    }
  }

  /// Replace the sidebar's contents.
  ///
  /// `sections` is `[{ title: String?, items: [{ id, label, symbol }] }]`. A
  /// section with no title is flattened to top-level rows, which is how the
  /// primary destinations sit above the first header.
  @objc(setSidebar:selectedId:)
  func setSidebar(sections: NSArray, selectedId: NSString?) {
    guard let sidebar = installIfNeeded() else { return }

    let parsed: [LMSidebarSection] = sections.compactMap { raw in
      guard let dict = raw as? [String: Any] else { return nil }
      let items = (dict["items"] as? [[String: Any]] ?? []).compactMap { item -> LMSidebarItem? in
        guard let id = item["id"] as? String, let label = item["label"] as? String else {
          return nil
        }
        return LMSidebarItem(
          id: id, label: label, symbol: item["symbol"] as? String ?? "circle")
      }
      return LMSidebarSection(title: dict["title"] as? String, items: items)
    }

    sidebar.apply(sections: parsed, selectedId: selectedId as String?)
  }

  /// Move the selection without rebuilding, e.g. when navigation happens from a
  /// menu command rather than a click in the sidebar.
  @objc(setSelectedItem:)
  func setSelectedItem(id: NSString) {
    sidebarViewController?.select(id: id as String)
  }

  @objc(toggleSidebar)
  func toggleSidebar() {
    splitViewController?.splitViewItems.first?.animator().isCollapsed =
      !(splitViewController?.splitViewItems.first?.isCollapsed ?? false)
  }

  /// Sheet-style confirmation. Resolves `true` when the confirm button was
  /// chosen — the AppKit stand-in for React Native's missing `Alert` on macOS.
  @objc(confirmDialog:resolver:rejecter:)
  func confirmDialog(
    options: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let alert = NSAlert()
    alert.messageText = options["title"] as? String ?? ""
    alert.informativeText = options["message"] as? String ?? ""
    alert.alertStyle = .warning
    let confirm = alert.addButton(withTitle: options["confirmTitle"] as? String ?? "OK")
    if options["destructive"] as? Bool == true {
      confirm.hasDestructiveAction = true
    }
    alert.addButton(withTitle: "Cancel")
    if let window = NSApp.keyWindow {
      alert.beginSheetModal(for: window) { response in
        resolve(response == .alertFirstButtonReturn)
      }
    } else {
      resolve(alert.runModal() == .alertFirstButtonReturn)
    }
  }

  /// Informational sheet with a single OK button.
  @objc(alertDialog:resolver:rejecter:)
  func alertDialog(
    options: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let alert = NSAlert()
    alert.messageText = options["title"] as? String ?? ""
    alert.informativeText = options["message"] as? String ?? ""
    if let window = NSApp.keyWindow {
      alert.beginSheetModal(for: window) { _ in resolve(nil) }
    } else {
      alert.runModal()
      resolve(nil)
    }
  }

  /// Save panel + download: ask where to put it, then stream the URL there.
  ///
  /// `URLSession.shared` rides the shared cookie storage, so the request is
  /// authenticated exactly like the app's own `fetch` calls. Resolves the
  /// saved path, or `nil` when the user cancels the panel.
  @objc(saveDownload:suggestedName:resolver:rejecter:)
  func saveDownload(
    urlString: NSString,
    suggestedName: NSString,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let url = URL(string: urlString as String) else {
      reject("bad_url", "Invalid download URL.", nil)
      return
    }

    let panel = NSSavePanel()
    panel.nameFieldStringValue = suggestedName as String
    panel.canCreateDirectories = true

    let start: (NSApplication.ModalResponse) -> Void = { response in
      guard response == .OK, let destination = panel.url else {
        resolve(nil)
        return
      }
      let task = URLSession.shared.downloadTask(with: url) { temp, response, error in
        // The temp file is deleted the moment this handler returns, so the
        // move happens here, synchronously, before hopping back to main.
        let result: Result<String, NSError>
        if let error {
          result = .failure(error as NSError)
        } else if let http = response as? HTTPURLResponse,
          !(200..<300).contains(http.statusCode)
        {
          result = .failure(
            NSError(
              domain: "LMShellModule", code: http.statusCode,
              userInfo: [
                NSLocalizedDescriptionKey: "The server returned an error (\(http.statusCode))."
              ]))
        } else if let temp {
          do {
            if FileManager.default.fileExists(atPath: destination.path) {
              try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: temp, to: destination)
            result = .success(destination.path)
          } catch {
            result = .failure(error as NSError)
          }
        } else {
          result = .failure(
            NSError(
              domain: "LMShellModule", code: -1,
              userInfo: [NSLocalizedDescriptionKey: "The download produced no file."]))
        }
        DispatchQueue.main.async {
          switch result {
          case .success(let path): resolve(path)
          case .failure(let error): reject("download_failed", error.localizedDescription, error)
          }
        }
      }
      task.resume()
    }

    if let window = NSApp.keyWindow {
      panel.beginSheetModal(for: window, completionHandler: start)
    } else {
      start(panel.runModal())
    }
  }
}
