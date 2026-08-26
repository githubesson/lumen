Pod::Spec.new do |s|
  s.name           = 'LumenSiriMedia'
  s.version        = '1.0.0'
  s.summary        = 'Siri media intent bridge for Lumen'
  s.description    = 'Routes SiriKit play-media requests into Lumen and donates playback metadata.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
