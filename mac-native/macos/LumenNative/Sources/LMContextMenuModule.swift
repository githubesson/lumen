import AppKit
import React

/// Right-click menus, drawn by AppKit.
///
/// react-native-macos exposes mouse enter/leave and double-click to JS but not
/// a right-click event, and a JS-drawn popup would neither match the system
/// menu nor dismiss with it. Handing the items to `NSMenu` gets the real thing:
/// correct materials, keyboard navigation, submenus and dismissal behaviour.
@objc(LMContextMenuModule)
final class LMContextMenuModule: NSObject {
  private var resolver: RCTPromiseResolveBlock?

  @objc var methodQueue: DispatchQueue { .main }

  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc private func handleSelection(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    resolve(with: id)
  }

  private func resolve(with value: String?) {
    guard let resolver else { return }
    self.resolver = nil
    resolver(value)
  }

  private func buildMenu(from items: [[String: Any]]) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false

    for descriptor in items {
      if descriptor["separator"] as? Bool == true {
        menu.addItem(.separator())
        continue
      }

      let title = descriptor["title"] as? String ?? ""

      if descriptor["header"] as? Bool == true {
        if #available(macOS 14.0, *) {
          menu.addItem(.sectionHeader(title: title))
        } else {
          let header = NSMenuItem(title: title, action: nil, keyEquivalent: "")
          header.isEnabled = false
          menu.addItem(header)
        }
        continue
      }

      let item = NSMenuItem(
        title: title,
        action: #selector(handleSelection(_:)),
        keyEquivalent: ""
      )
      item.target = self
      item.representedObject = descriptor["id"] as? String
      item.isEnabled = descriptor["disabled"] as? Bool != true
      if descriptor["checked"] as? Bool == true { item.state = .on }

      if let symbol = descriptor["symbol"] as? String {
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
      }

      if descriptor["destructive"] as? Bool == true {
        // AppKit has no public destructive-item styling, so paint it the way
        // the system apps look: red title, red symbol.
        item.attributedTitle = NSAttributedString(
          string: title,
          attributes: [
            .foregroundColor: NSColor.systemRed,
            .font: NSFont.menuFont(ofSize: 0),
          ])
        if let image = item.image {
          item.image =
            image.withSymbolConfiguration(.init(paletteColors: [.systemRed])) ?? image
        }
      }

      if let children = descriptor["children"] as? [[String: Any]], !children.isEmpty {
        // A submenu's parent is a container, not a command: clearing the action
        // stops it resolving the promise when the pointer passes over it.
        item.action = nil
        item.target = nil
        item.submenu = buildMenu(from: children)
      }

      menu.addItem(item)
    }

    return menu
  }

  @objc(show:position:resolver:rejecter:)
  func show(
    items: NSArray,
    position: NSDictionary,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    // A menu already up is dismissed by the new one; settle its promise so the
    // caller is not left awaiting forever.
    self.resolve(with: nil)
    resolver = resolve

    guard let window = NSApp.keyWindow,
          let descriptors = items as? [[String: Any]]
    else {
      self.resolve(with: nil)
      return
    }

    let menu = buildMenu(from: descriptors)
    let x = position["x"] as? Double ?? 0
    let y = position["y"] as? Double ?? 0

    // React reports page coordinates with the origin at the top-left; AppKit
    // windows are bottom-left origin.
    let contentHeight = window.contentView?.bounds.height ?? 0
    let point = NSPoint(x: x, y: contentHeight - y)

    let didShow = menu.popUp(positioning: nil, at: point, in: window.contentView)
    if !didShow {
      self.resolve(with: nil)
    } else if resolver != nil {
      // popUp returns once the menu closes; a nil selection means dismissal.
      self.resolve(with: nil)
    }
  }
}
