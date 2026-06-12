import AVKit
import ExpoModulesCore

class AirPlayRoutePickerView: ExpoView {
  let routePickerView = AVRoutePickerView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    clipsToBounds = true
    routePickerView.backgroundColor = .clear
    routePickerView.prioritizesVideoDevices = false
    addSubview(routePickerView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    routePickerView.frame = bounds
  }
}
