import ExpoModulesCore
import MediaPlayer

public class LockScreenControlsModule: Module {
  private let commandCenter = MPRemoteCommandCenter.shared()
  private var nextTarget: Any?
  private var previousTarget: Any?

  public func definition() -> ModuleDefinition {
    Name("LockScreenControls")

    Events("onCommand")

    Function("setEnabled") { (enabled: Bool) in
      if enabled {
        self.enable()
      } else {
        self.disable()
      }
    }

    OnDestroy {
      self.disable()
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
