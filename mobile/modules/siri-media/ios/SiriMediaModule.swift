import ExpoModulesCore
import Intents

// Keep a cold-launch request alive long enough for Expo and auth hydration.
private let siriRequestTimeout: TimeInterval = 60
// A warm app can resolve and start playback quickly enough to return `.success`.
// Only fall back to `.inProgress` when startup or the catalog takes longer.
private let siriProgressResponseDelay: TimeInterval = 4

struct SiriMediaItemSpec: Record {
  @Field var identifier: String = ""
  @Field var title: String = ""
  @Field var type: String = "unknown"
  @Field var artist: String?

  init() {}

  init(identifier: String, title: String, type: String, artist: String? = nil) {
    self.identifier = identifier
    self.title = title
    self.type = type
    self.artist = artist
  }
}

struct SiriPlayMediaRequestSpec: Record {
  @Field var requestId: String = ""
  @Field var mediaName: String?
  @Field var artistName: String?
  @Field var albumName: String?
  @Field var mediaIdentifier: String?
  @Field var mediaType: String = "unknown"
  @Field var mediaItems: [SiriMediaItemSpec] = []
  @Field var mediaContainer: SiriMediaItemSpec?
  @Field var playShuffled: Bool?
  @Field var resumePlayback: Bool?

  init() {}

  init(intent: INPlayMediaIntent) {
    let search = intent.mediaSearch
    let items = (intent.mediaItems ?? []).map(SiriMediaItemSpec.init)
    let container = intent.mediaContainer.map(SiriMediaItemSpec.init)
    let hasMediaItems = !items.isEmpty

    self.requestId = UUID().uuidString
    self.mediaName = hasMediaItems
      ? search?.mediaName ?? items.first?.title
      : container?.title ?? search?.mediaName
    self.artistName = search?.artistName ?? items.first?.artist
    self.albumName = search?.albumName
    self.mediaIdentifier = hasMediaItems
      ? search?.mediaIdentifier ?? items.first?.identifier
      : container?.identifier ?? search?.mediaIdentifier
    self.mediaType = siriMediaTypeName(
      requestedMediaType(
        search: search,
        container: intent.mediaContainer,
        items: intent.mediaItems ?? []
      )
    )
    self.mediaItems = items
    self.mediaContainer = container
    self.playShuffled = intent.playShuffled
    self.resumePlayback = intent.resumePlayback
  }

  var eventPayload: [String: Any?] {
    [
      "requestId": requestId,
      "mediaName": mediaName,
      "artistName": artistName,
      "albumName": albumName,
      "mediaIdentifier": mediaIdentifier,
      "mediaType": mediaType,
      "mediaItems": mediaItems.map(\.eventPayload),
      "mediaContainer": mediaContainer?.eventPayload,
      "playShuffled": playShuffled,
      "resumePlayback": resumePlayback,
    ]
  }
}

private extension SiriMediaItemSpec {
  init(_ item: INMediaItem) {
    self.init(
      identifier: item.identifier ?? "",
      title: item.title ?? "",
      type: siriMediaTypeName(item.type),
      artist: item.artist
    )
  }

  var eventPayload: [String: Any?] {
    [
      "identifier": identifier,
      "title": title,
      "type": type,
      "artist": artist,
    ]
  }

  var mediaItem: INMediaItem {
    INMediaItem(
      identifier: identifier,
      title: title,
      type: siriMediaType(type),
      artwork: nil,
      artist: artist
    )
  }
}

private func siriMediaTypeName(_ type: INMediaItemType) -> String {
  switch type {
  case .album:
    return "album"
  case .artist:
    return "artist"
  case .music:
    return "music"
  case .playlist:
    return "playlist"
  case .song:
    return "song"
  default:
    return "unknown"
  }
}

private func siriMediaType(_ type: String) -> INMediaItemType {
  switch type {
  case "album":
    return .album
  case "artist":
    return .artist
  case "music":
    return .music
  case "playlist":
    return .playlist
  case "song":
    return .song
  default:
    return .unknown
  }
}

private func requestedMediaType(
  search: INMediaSearch?,
  container: INMediaItem?,
  items: [INMediaItem]
) -> INMediaItemType {
  if let itemType = items.first?.type, itemType != .unknown {
    return itemType
  }
  if let containerType = container?.type, containerType != .unknown {
    return containerType
  }
  if let searchType = search?.mediaType, searchType != .unknown {
    return searchType
  }
  return .unknown
}

private func siriAuthorizationStatusName(_ status: INSiriAuthorizationStatus) -> String {
  switch status {
  case .authorized:
    return "authorized"
  case .denied:
    return "denied"
  case .notDetermined:
    return "notDetermined"
  case .restricted:
    return "restricted"
  @unknown default:
    return "unavailable"
  }
}

private func immediateMediaResolution(
  for intent: INPlayMediaIntent
) -> [INPlayMediaMediaItemResolutionResult] {
  let suppliedItems = (intent.mediaItems ?? []).filter {
    !($0.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  if !suppliedItems.isEmpty {
    return INPlayMediaMediaItemResolutionResult.successes(with: suppliedItems)
  }

  // A playlist or album may arrive only as `mediaContainer`. There is no
  // `mediaItems` parameter to resolve in that supported combination; preserve
  // the container for the playback phase instead of turning it into a song.
  if let containerTitle = intent.mediaContainer?.title?
    .trimmingCharacters(in: .whitespacesAndNewlines),
    !containerTitle.isEmpty
  {
    return [INPlayMediaMediaItemResolutionResult.notRequired()]
  }

  let search = intent.mediaSearch
  let title = [search?.mediaName, search?.albumName, search?.artistName]
    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
    .first { !$0.isEmpty }
  guard let title else {
    // Generic requests such as "play music" or "shuffle something" don't
    // need a media parameter; JavaScript chooses from recent listening.
    return [INPlayMediaMediaItemResolutionResult.notRequired()]
  }

  let requestedType = search?.mediaType ?? .unknown
  let item = INMediaItem(
    identifier: search?.mediaIdentifier,
    title: title,
    type: requestedType == .unknown ? .music : requestedType,
    artwork: nil,
    artist: search?.artistName
  )
  return INPlayMediaMediaItemResolutionResult.successes(with: [item])
}

private final class PendingSiriRequest {
  let spec: SiriPlayMediaRequestSpec
  /// Arrival order. Request ids are random UUIDs, so they can't order the
  /// backlog a cold launch hands to JavaScript.
  let sequence: Int
  let completion: (INPlayMediaIntentResponse) -> Void
  let timeout: DispatchWorkItem
  var progressResponse: DispatchWorkItem?
  var responded = false

  init(
    spec: SiriPlayMediaRequestSpec,
    sequence: Int,
    completion: @escaping (INPlayMediaIntentResponse) -> Void,
    timeout: DispatchWorkItem
  ) {
    self.spec = spec
    self.sequence = sequence
    self.completion = completion
    self.timeout = timeout
  }
}

private final class SiriMediaCoordinator {
  static let shared = SiriMediaCoordinator()

  var onRequest: ((SiriPlayMediaRequestSpec) -> Void)?
  private var requests: [String: PendingSiriRequest] = [:]
  private var nextSequence = 0

  private init() {}

  func enqueuePlayback(
    intent: INPlayMediaIntent,
    completion: @escaping (INPlayMediaIntentResponse) -> Void
  ) {
    enqueue(
      spec: SiriPlayMediaRequestSpec(intent: intent),
      completion: completion,
      progressAfter: siriProgressResponseDelay
    )
  }

  func pendingRequests() -> [SiriPlayMediaRequestSpec] {
    requests.values
      .sorted { $0.sequence < $1.sequence }
      .map(\.spec)
  }

  func completePlayback(requestId: String, result: String) {
    guard let pending = take(requestId: requestId) else { return }

    NSLog("LUMENSIRI: completed playback request result=%@", result)

    // `.inProgress` may already have satisfied Siri's response deadline. The
    // request still stays alive so JavaScript can start playback, but SiriKit's
    // completion handler must only be invoked once.
    guard !pending.responded else { return }
    pending.responded = true

    let code: INPlayMediaIntentResponseCode
    switch result {
    case "success":
      code = .success
    case "noContent":
      code = .failureNoUnplayedContent
    case "requiresAppLaunch":
      code = .failureRequiringAppLaunch
    case "unsupported":
      code = .failureUnknownMediaType
    default:
      code = .failure
    }
    pending.completion(INPlayMediaIntentResponse(code: code, userActivity: nil))
  }

  private func enqueue(
    spec: SiriPlayMediaRequestSpec,
    completion: @escaping (INPlayMediaIntentResponse) -> Void,
    progressAfter: TimeInterval
  ) {
    DispatchQueue.main.async {
      let requestId = spec.requestId
      let timeout = DispatchWorkItem { [weak self] in
        self?.timeout(requestId: requestId)
      }
      let pending = PendingSiriRequest(
        spec: spec,
        sequence: self.nextSequence,
        completion: completion,
        timeout: timeout
      )
      self.nextSequence += 1
      let progressResponse = DispatchWorkItem { [weak self] in
        self?.respondInProgress(requestId: requestId)
      }
      pending.progressResponse = progressResponse
      DispatchQueue.main.asyncAfter(
        deadline: .now() + progressAfter,
        execute: progressResponse
      )
      self.requests[requestId] = pending
      self.onRequest?(spec)
      DispatchQueue.main.asyncAfter(
        deadline: .now() + siriRequestTimeout,
        execute: timeout
      )
    }
  }

  private func take(requestId: String) -> PendingSiriRequest? {
    guard let pending = requests.removeValue(forKey: requestId) else { return nil }
    pending.timeout.cancel()
    pending.progressResponse?.cancel()
    return pending
  }

  private func respondInProgress(requestId: String) {
    guard let pending = requests[requestId], !pending.responded else { return }
    pending.responded = true
    NSLog("LUMENSIRI: playback still loading; responding inProgress")
    pending.completion(INPlayMediaIntentResponse(code: .inProgress, userActivity: nil))
  }

  private func timeout(requestId: String) {
    guard let pending = take(requestId: requestId), !pending.responded else { return }
    pending.responded = true
    pending.completion(INPlayMediaIntentResponse(code: .failure, userActivity: nil))
  }
}

/// Main-app SiriKit handler returned by the generated AppDelegate. Keeping the
/// handler in the app process lets the existing React player own playback.
public final class LumenPlayMediaIntentHandler: NSObject, INPlayMediaIntentHandling {
  public static let shared = LumenPlayMediaIntentHandler()

  private override init() {
    super.init()
  }

  public func resolveMediaItems(
    for intent: INPlayMediaIntent,
    with completion: @escaping ([INPlayMediaMediaItemResolutionResult]) -> Void
  ) {
    // Do not put Siri's resolution phase behind React startup or a network
    // request. The app resolves the structured search against its catalog in
    // the playback phase, after Siri has handed the request to the app.
    let resolution = immediateMediaResolution(for: intent)
    NSLog("LUMENSIRI: resolved media request results=%d", resolution.count)
    completion(resolution)
  }

  public func handle(
    intent: INPlayMediaIntent,
    completion: @escaping (INPlayMediaIntentResponse) -> Void
  ) {
    // Let a warm React player return `.success` after it has accepted the
    // queue. A cold Expo launch gets a bounded grace period before the
    // coordinator responds `.inProgress` while playback continues loading.
    SiriMediaCoordinator.shared.enqueuePlayback(
      intent: intent,
      completion: completion
    )
    NSLog("LUMENSIRI: queued playback request")
  }
}

public final class SiriMediaModule: Module {
  private let coordinator = SiriMediaCoordinator.shared

  public func definition() -> ModuleDefinition {
    Name("SiriMedia")

    Events("onPlayMediaRequest")

    OnCreate {
      // Link-time reference: AppDelegate constructs this class by name from a
      // separate static framework, so keep its object file in the final app.
      _ = LumenPlayMediaIntentHandler.shared
      self.coordinator.onRequest = { [weak self] request in
        self?.sendEvent("onPlayMediaRequest", request.eventPayload)
      }
    }

    OnDestroy {
      self.coordinator.onRequest = nil
    }

    AsyncFunction("getPendingRequests") { () -> [SiriPlayMediaRequestSpec] in
      self.coordinator.pendingRequests()
    }.runOnQueue(.main)

    AsyncFunction("completePlayback") { (requestId: String, result: String) in
      self.coordinator.completePlayback(requestId: requestId, result: result)
    }.runOnQueue(.main)

    Function("authorizationStatus") { () -> String in
      siriAuthorizationStatusName(INPreferences.siriAuthorizationStatus())
    }

    AsyncFunction("requestAuthorization") { (promise: Promise) in
      INPreferences.requestSiriAuthorization { status in
        promise.resolve(siriAuthorizationStatusName(status))
      }
    }.runOnQueue(.main)

    AsyncFunction("setPlaylistVocabulary") { (names: [String]) in
      let vocabulary = NSOrderedSet(array: names.filter { !$0.isEmpty })
      INVocabulary.shared().setVocabularyStrings(
        vocabulary,
        of: .mediaPlaylistTitle
      )
    }

    AsyncFunction("donatePlayback") {
      (item: SiriMediaItemSpec, container: SiriMediaItemSpec?, playShuffled: Bool, promise: Promise) in
      let intent = INPlayMediaIntent(
        mediaItems: [item.mediaItem],
        mediaContainer: container?.mediaItem,
        playShuffled: playShuffled,
        playbackRepeatMode: .none,
        resumePlayback: false
      )
      let interaction = INInteraction(intent: intent, response: nil)
      interaction.identifier = "lumen.play.\(item.identifier)"
      interaction.donate { error in
        promise.resolve(error == nil)
      }
    }
  }
}
