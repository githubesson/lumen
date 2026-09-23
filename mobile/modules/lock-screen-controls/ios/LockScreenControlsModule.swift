import ExpoModulesCore
import MediaPlayer

public class LockScreenControlsModule: Module {
  private let commandCenter = MPRemoteCommandCenter.shared()
  private var nextTarget: Any?
  private var previousTarget: Any?

  public func definition() -> ModuleDefinition {
    Name("LockScreenControls")

    Events("onCommand")

    // Sync functions run on the JS thread and OnDestroy on another, while
    // expo-audio configures the same command center on the main thread. Hop to
    // main so the targets and `isEnabled` are only ever touched from one
    // thread; the serial queue keeps calls in order.
    Function("setEnabled") { (enabled: Bool) in
      DispatchQueue.main.async { [weak self] in
        if enabled {
          self?.enable()
        } else {
          self?.disable()
        }
      }
    }

    OnDestroy {
      // Strong capture: the module must outlive this block, or the targets
      // it registered would never be removed.
      DispatchQueue.main.async {
        self.disable()
      }
    }
  }

  private func enable() {
    if nextTarget == nil {
      nextTarget = commandCenter.nextTrackCommand.addTarget { [weak self] _ in
        self?.sendEvent("onCommand", ["action": "next"])
        return .success
      }
    }

    if previousTarget == nil {
      previousTarget = commandCenter.previousTrackCommand.addTarget { [weak self] _ in
        self?.sendEvent("onCommand", ["action": "previous"])
        return .success
      }
    }

    commandCenter.nextTrackCommand.isEnabled = true
    commandCenter.previousTrackCommand.isEnabled = true
  }

  private func disable() {
    if let nextTarget {
      commandCenter.nextTrackCommand.removeTarget(nextTarget)
      self.nextTarget = nil
    }

    if let previousTarget {
      commandCenter.previousTrackCommand.removeTarget(previousTarget)
      self.previousTarget = nil
    }

    commandCenter.nextTrackCommand.isEnabled = false
    commandCenter.previousTrackCommand.isEnabled = false
  }
}
