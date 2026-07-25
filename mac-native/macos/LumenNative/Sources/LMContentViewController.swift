import AppKit
import React

/// Hosts React Native's root view controller inside the split view's content
/// pane.
///
/// `NSSplitViewController` positions its items with Auto Layout, while React
/// Native's root view is frame-driven and sized itself to the whole window
/// before it was re-parented. Left as a direct split item it kept that width
/// and overhung the pane by the sidebar's width, pushing everything
/// right-aligned off-screen. This wrapper is the split item instead, and hands
/// the root view an explicit frame on every layout pass.
///
/// The frame is the full `bounds`, not `safeAreaRect`: the glass toolbar tints
/// itself from what is behind it, so content has to run underneath it.
final class LMContentViewController: NSViewController {
  private let child: NSViewController

  init(child: NSViewController) {
    self.child = child
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMContentViewController is created programmatically only")
  }

  override func loadView() {
    // Deliberately no background of its own: the window root carries one
    // shared vibrancy backdrop (`LMWindowBackdropView`) under the whole split
    // view, so painting another here would just re-tint this pane and split
    // the window into two surfaces again.
    let container = LMFlippedView()
    container.autoresizingMask = [.width, .height]
    view = container

    addChild(child)
    child.view.autoresizingMask = [.width, .height]
    // React Native's content is transparent so the window backdrop shows
    // through everywhere. Painting it in JS instead left a visible seam where
    // the theme's flat colour met the table's system background.
    //
    // `RCTRootView` ships with an opaque white background (`RCTRootView.m`),
    // and on macOS that colour is filled in `drawRect:` — clearing the layer
    // alone left the fill in place, which is what painted the whole content
    // pane white over the material below it.
    LMContentViewController.clearSurfaceBackground(child.view)
    container.addSubview(child.view)
  }

  /// While the sidebar animates, the React root is frozen at its final frame,
  /// expressed in window coordinates. The animated pane resize then only moves
  /// the root's origin — same size, so React Native never re-lays-out mid
  /// animation, which is what made the slide stutter.
  var pinnedWindowFrame: NSRect?

  override func viewDidLayout() {
    super.viewDidLayout()
    applyChildFrame()
    // The surface view is created asynchronously, so the chain is re-cleared
    // here as well: on the first layout it may not have existed yet.
    LMContentViewController.clearSurfaceBackground(child.view)
  }

  private func applyChildFrame() {
    if let pinned = pinnedWindowFrame, view.window != nil {
      child.view.frame = view.convert(pinned, from: nil)
    } else {
      child.view.frame = view.bounds
    }
  }

  /// Make React Native's surface plumbing transparent.
  ///
  /// The root view ships opaque — white — and on macOS that colour is filled in
  /// `drawRect:`, so clearing the layer alone leaves it painted. Every view in
  /// the chain from the hosting view down to the React root does it, which is
  /// what covered the pane's material with a flat white rectangle.
  ///
  /// Only React Native's own surface classes are touched; the walk stops as
  /// soon as it reaches app content, whose backgrounds belong to JS.
  private static func clearSurfaceBackground(_ view: NSView) {
    var cursor: NSView? = view
    while let current = cursor {
      let name = NSStringFromClass(type(of: current))
      guard name.hasPrefix("RCTSurface") || name.hasPrefix("RCTRootView") else { return }
      if current.responds(to: NSSelectorFromString("setBackgroundColor:")) {
        current.setValue(NSColor.clear, forKey: "backgroundColor")
      }
      current.wantsLayer = true
      current.layer?.backgroundColor = NSColor.clear.cgColor
      cursor = current.subviews.first
    }
  }

  /// Force the hosted root view to pick up the pane's current size.
  ///
  /// Collapsing the sidebar resizes this pane outside a normal layout pass, and
  /// React Native only re-measures its shadow tree from `layout` — so without
  /// this the JS side keeps laying out at the old, narrower width and anything
  /// anchored to the right edge falls off-screen.
  func syncChildFrame() {
    view.layoutSubtreeIfNeeded()
    applyChildFrame()
    child.view.needsLayout = true
    child.view.layoutSubtreeIfNeeded()
  }
}

/// Plain transparent container for the React root view. RN frames are
/// top-left origin, so the container is flipped to match.
private final class LMFlippedView: NSView {
  override var isFlipped: Bool { true }
}

/// The one background the whole window sits on. Installed at the window root,
/// underneath the split view, so the sidebar pane and the content pane are the
/// same surface — giving each pane its own backing put a visible seam between
/// them. Everything drawn on top — the sidebar's source list, React's content
/// and the track table — is transparent, which is what lets this show through.
final class LMWindowBackdropView: NSVisualEffectView {
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    material = .sidebar
    blendingMode = .behindWindow
    state = .followsWindowActiveState
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("LMWindowBackdropView is created programmatically only")
  }
}
