import AVFoundation
import AppKit
import MediaPlayer
import React

/// Audio playback, Now Playing metadata and remote commands in one module.
///
/// They are merged deliberately: `MPNowPlayingInfoCenter` needs exactly the
/// state `AVPlayer` already owns (rate, elapsed time, item duration), so
/// splitting them would mean mirroring playback state across two modules and
/// two JS round-trips per transport change.
///
/// `AVPlayer` covers both of the backend's delivery modes natively — HTTP range
/// requests for local files and the HLS proxy used for TIDAL-sourced tracks — so
/// there is no second code path for streaming.
@objc(LMPlaybackModule)
final class LMPlaybackModule: RCTEventEmitter {
  private var player = AVPlayer()
  private var timeObserver: Any?
  private var itemStatusObservation: NSKeyValueObservation?
  private var rateObservation: NSKeyValueObservation?
  private var endObserver: NSObjectProtocol?
  private var hasListeners = false
  private var remoteCommandsWired = false
  private var artworkTask: URLSessionDataTask?
  private var lastArtworkURL: String?

  /// AVPlayer, MPNowPlayingInfoCenter and MPRemoteCommandCenter are all main
  /// thread APIs, so take every call there rather than hopping per method.
  override var methodQueue: DispatchQueue { .main }

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String] {
    return [
      "loadedmetadata",
      "timeupdate",
      "play",
      "pause",
      "seeked",
      "ended",
      "error",
      "remoteCommand",
    ]
  }

  override init() {
    super.init()
    player.automaticallyWaitsToMinimizeStalling = false
    observeRate()
    addTimeObserver()
  }

  deinit {
    teardownObservers()
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  private func emit(_ name: String, _ body: [String: Any] = [:]) {
    guard hasListeners else { return }
    sendEvent(withName: name, body: body)
  }

  // MARK: - Observation

  private func observeRate() {
    rateObservation = player.observe(\.rate, options: [.new]) { [weak self] player, _ in
      guard let self else { return }
      let playing = player.rate > 0
      self.emit(playing ? "play" : "pause")
      // macOS only routes the media keys to the app the system considers "now
      // playing", and that hinges on playbackState — unlike iOS, where the
      // audio session alone is enough.
      MPNowPlayingInfoCenter.default().playbackState = playing ? .playing : .paused
      self.refreshElapsedTime()
    }
  }

  private func addTimeObserver() {
    // 0.5s is deliberately coarse: the JS player interpolates between ticks, so
    // a faster observer would only add bridge traffic.
    let interval = CMTime(seconds: 0.5, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
    timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) {
      [weak self] time in
      guard let self else { return }
      self.emit("timeupdate", ["currentTime": time.seconds.isFinite ? time.seconds : 0])
    }
  }

  private func teardownObservers() {
    if let timeObserver {
      player.removeTimeObserver(timeObserver)
      self.timeObserver = nil
    }
    itemStatusObservation?.invalidate()
    itemStatusObservation = nil
    rateObservation?.invalidate()
    rateObservation = nil
    if let endObserver {
      NotificationCenter.default.removeObserver(endObserver)
      self.endObserver = nil
    }
  }

  private func observe(item: AVPlayerItem) {
    itemStatusObservation?.invalidate()
    itemStatusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      guard let self else { return }
      switch item.status {
      case .readyToPlay:
        let duration = item.duration.seconds
        self.emit("loadedmetadata", ["duration": duration.isFinite ? duration : 0])
      case .failed:
        self.emit("error", ["message": item.error?.localizedDescription ?? "Playback failed"])
      default:
        break
      }
    }

    if let endObserver {
      NotificationCenter.default.removeObserver(endObserver)
    }
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: item,
      queue: .main
    ) { [weak self] _ in
      self?.emit("ended")
    }
  }

  // MARK: - Transport

  @objc(load:)
  func load(url: NSString) {
    guard let parsed = URL(string: url as String) else {
      emit("error", ["message": "Invalid URL"])
      return
    }
    let item = AVPlayerItem(url: parsed)
    observe(item: item)
    player.replaceCurrentItem(with: item)
  }

  @objc(play:rejecter:)
  func play(resolve: @escaping RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    player.play()
    resolve(nil)
  }

  @objc(pause)
  func pause() {
    player.pause()
  }

  @objc(seek:)
  func seek(seconds: Double) {
    guard seconds.isFinite, seconds >= 0 else { return }
    let time = CMTime(seconds: seconds, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
    // Zero tolerance: the scrubber should land where the user dropped it, not
    // at the nearest keyframe.
    player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
      self?.emit("seeked")
      self?.refreshElapsedTime()
    }
  }

  @objc(setVolume:)
  func setVolume(volume: Double) {
    player.volume = Float(max(0, min(1, volume)))
  }

  @objc(setMuted:)
  func setMuted(muted: Bool) {
    player.isMuted = muted
  }

  @objc(dispose)
  func dispose() {
    player.pause()
    player.replaceCurrentItem(with: nil)
    clearNowPlayingInfo()
  }

  // MARK: - Now Playing

  @objc(setNowPlayingInfo:)
  func setNowPlayingInfo(info: NSDictionary) {
    var entries: [String: Any] = [:]
    entries[MPMediaItemPropertyTitle] = info["title"] as? String ?? ""
    if let artist = info["artist"] as? String { entries[MPMediaItemPropertyArtist] = artist }
    if let album = info["album"] as? String { entries[MPMediaItemPropertyAlbumTitle] = album }
    if let duration = info["duration"] as? Double, duration.isFinite, duration > 0 {
      entries[MPMediaItemPropertyPlaybackDuration] = duration
    }
    entries[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTimeSeconds()
    entries[MPNowPlayingInfoPropertyPlaybackRate] = Double(player.rate)

    let center = MPNowPlayingInfoCenter.default()
    // Preserve artwork already fetched for this track so a metadata refresh
    // (elapsed time, rate) does not blank the image and re-download it.
    if let existing = center.nowPlayingInfo?[MPMediaItemPropertyArtwork],
       lastArtworkURL == info["artworkUrl"] as? String {
      entries[MPMediaItemPropertyArtwork] = existing
    }
    center.nowPlayingInfo = entries

    if let artworkUrl = info["artworkUrl"] as? String, artworkUrl != lastArtworkURL {
      lastArtworkURL = artworkUrl
      loadArtwork(from: artworkUrl)
    }
  }

  @objc(clearNowPlayingInfo)
  func clearNowPlayingInfo() {
    artworkTask?.cancel()
    lastArtworkURL = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    MPNowPlayingInfoCenter.default().playbackState = .stopped
  }

  private func refreshElapsedTime() {
    let center = MPNowPlayingInfoCenter.default()
    guard var info = center.nowPlayingInfo else { return }
    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTimeSeconds()
    info[MPNowPlayingInfoPropertyPlaybackRate] = Double(player.rate)
    center.nowPlayingInfo = info
  }

  private func currentTimeSeconds() -> Double {
    let seconds = player.currentTime().seconds
    return seconds.isFinite ? seconds : 0
  }

  private func loadArtwork(from urlString: String) {
    guard let url = URL(string: urlString) else { return }
    artworkTask?.cancel()
    artworkTask = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let self,
            let data,
            let image = NSImage(data: data),
            // A late response for a track the user already skipped past must not
            // overwrite the current one's artwork.
            self.lastArtworkURL == urlString
      else { return }
      let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
      DispatchQueue.main.async {
        guard self.lastArtworkURL == urlString else { return }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyArtwork] = artwork
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
      }
    }
    artworkTask?.resume()
  }

  // MARK: - Remote commands

  @objc(setRemoteCommandsEnabled:)
  func setRemoteCommandsEnabled(enabled: Bool) {
    let center = MPRemoteCommandCenter.shared()

    if enabled, !remoteCommandsWired {
      remoteCommandsWired = true
      center.playCommand.addTarget { [weak self] _ in
        self?.emit("remoteCommand", ["action": "play"])
        return .success
      }
      center.pauseCommand.addTarget { [weak self] _ in
        self?.emit("remoteCommand", ["action": "pause"])
        return .success
      }
      center.togglePlayPauseCommand.addTarget { [weak self] _ in
        self?.emit("remoteCommand", ["action": "toggle"])
        return .success
      }
      center.nextTrackCommand.addTarget { [weak self] _ in
        self?.emit("remoteCommand", ["action": "next"])
        return .success
      }
      center.previousTrackCommand.addTarget { [weak self] _ in
        self?.emit("remoteCommand", ["action": "previous"])
        return .success
      }
      center.changePlaybackPositionCommand.addTarget { [weak self] event in
        guard let positionEvent = event as? MPChangePlaybackPositionCommandEvent else {
          return .commandFailed
        }
        self?.emit("remoteCommand", [
          "action": "seek",
          "position": positionEvent.positionTime,
        ])
        return .success
      }
    }

    center.playCommand.isEnabled = enabled
    center.pauseCommand.isEnabled = enabled
    center.togglePlayPauseCommand.isEnabled = enabled
    center.nextTrackCommand.isEnabled = enabled
    center.previousTrackCommand.isEnabled = enabled
    center.changePlaybackPositionCommand.isEnabled = enabled
  }
}
