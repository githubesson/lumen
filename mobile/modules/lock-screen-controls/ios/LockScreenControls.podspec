Pod::Spec.new do |s|
  s.name           = 'LockScreenControls'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS lock screen track control bridge for Expo'
  s.description    = 'A local Expo module that exposes next and previous lock screen media commands to JavaScript.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
