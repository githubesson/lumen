import ExpoModulesCore
import UIKit

public class AirPlayRoutePickerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AirPlayRoutePicker")

    View(AirPlayRoutePickerView.self) {
      Prop("tintColor") { (view: AirPlayRoutePickerView, tintColor: UIColor?) in
        view.routePickerView.tintColor = tintColor
      }

      Prop("activeTintColor") { (view: AirPlayRoutePickerView, activeTintColor: UIColor?) in
        view.routePickerView.activeTintColor = activeTintColor
      }

      Prop("prioritizesVideoDevices", false) { (view: AirPlayRoutePickerView, prioritizesVideoDevices: Bool) in
        view.routePickerView.prioritizesVideoDevices = prioritizesVideoDevices
      }
    }
  }
}
