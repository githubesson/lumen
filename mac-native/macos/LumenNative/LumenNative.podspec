Pod::Spec.new do |s|
  s.name         = 'LumenNative'
  s.version      = '0.1.0'
  s.summary      = 'Native AppKit / AVFoundation / MediaPlayer bridges for the Lumen macOS client.'
  s.description  = <<-DESC
    Swift native modules and view managers backing the Lumen desktop app:
    AVPlayer-based audio with Now Playing + remote command support, NSMenu
    integration for the main menu and context menus, NSVisualEffectView
    vibrancy, and SF Symbol image views.
  DESC
  s.homepage     = 'https://github.com/githubesson/lumen'
  s.license      = { :type => 'MIT' }
  s.author       = { 'Lumen' => 'noreply@example.com' }
  s.platforms    = { :osx => '14.0' }
  s.source       = { :path => '.' }

  s.source_files  = 'Sources/**/*.{h,m,mm,swift}'
  s.swift_version = '5.0'

  s.dependency 'React-Core'
end
