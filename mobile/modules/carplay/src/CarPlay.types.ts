import type { EventSubscription } from "expo-modules-core";

/** One cover in a shelf row. */
export type CarPlayImage = {
  /** Echoed back in `onSelect` when this cover is tapped. */
  id: string;
  imageUrl: string;
};

export type CarPlayListItem = {
  /** Stable id echoed back in `onSelect`; use track/album/playlist ids. */
  id: string;
  text: string;
  detailText?: string;
  /** Draws the CarPlay now-playing bars on the row. */
  isPlaying?: boolean;
  /** Defaults to true. A disabled row is dimmed and raises no `onSelect`. */
  enabled?: boolean;
  /** Set on rows that push another list, not on rows that start playback. */
  showsDisclosureIndicator?: boolean;
  /** Artwork: an https cover URL, or `file://` for a downloaded track. Loaded
   *  natively and applied to the row when it arrives. */
  imageUrl?: string;
  /** SF Symbol name. The whole image on a browse row; on a track row, the
   *  placeholder held until `imageUrl` loads. */
  symbol?: string;
  /** Non-empty turns the row into a shelf: covers side by side, each its own
   *  tap target. Only the first `maximumImageRowCount` are drawn. */
  images?: CarPlayImage[];
};

export type CarPlayListSection = {
  header?: string;
  headerSubtitle?: string;
  /** Adds the chevron beside the header; selecting it fires `onSelect` with
   *  this id. The "see all" affordance next to a shelf. */
  headerButtonId?: string;
  /** Single character for the fast-scroll index beside a long list. */
  indexTitle?: string;
  items: CarPlayListItem[];
};

export type CarPlayListTemplate = {
  /** Stable id, required by `updateList` to find the template again. */
  id: string;
  /** Fixed when the template is built; `updateList` cannot change it. */
  title: string;
  sections: CarPlayListSection[];
  emptyTitle?: string;
  emptyText?: string;
  /** Spinner over the empty view while the first load is still in flight. */
  loading?: boolean;
  /** Label and SF Symbol used when this template is one of the root tabs. */
  tabTitle?: string;
  tabSymbol?: string;
  /** Trailing navigation-bar button; selecting it fires `onSelect` with its id. */
  navButton?: CarPlayNavButton;
};

/** A button in a template's navigation bar. */
export type CarPlayNavButton = {
  id: string;
  /** SF Symbol name. */
  symbol: string;
  enabled?: boolean;
};

/** A button under the transport controls on the now-playing screen. */
export type CarPlayNowPlayingButton = {
  /** Echoed back in the `onNowPlayingButton` event. */
  id: string;
  /** SF Symbol name. */
  symbol: string;
  /** Drawn selected — how shuffle and repeat show that they are on. */
  selected?: boolean;
  enabled?: boolean;
};

export type CarPlayNowPlayingConfig = {
  buttons: CarPlayNowPlayingButton[];
  /** Label on the system Up Next button. */
  upNextTitle?: string;
  upNextEnabled?: boolean;
  /** Enables the system button that leads back to the album or playlist. */
  albumArtistEnabled?: boolean;
};

export type CarPlaySelectEvent = {
  /** Pass to `finishSelection` to stop the row's spinner. */
  selectionId: string;
  templateId: string;
  itemId: string;
};

export type CarPlayNowPlayingButtonEvent = { buttonId: string };

/** Rendering limits reported by the connected head unit. */
export type CarPlayListLimits = {
  /** Items rendered across all sections of one list; the rest are dropped. */
  maximumItemCount: number;
  maximumSectionCount: number;
  /** Root tabs the head unit will show; the rest are dropped. */
  maximumTabCount: number;
  /** Covers drawn in one shelf row. */
  maximumImageRowCount: number;
};

export type CarPlayNativeModule = CarPlayListLimits & {
  isConnected(): boolean;
  /** False between a cold boot and the phone's first unlock, while the app's
   *  cached session, downloads and persisted library are all unreadable. */
  isProtectedDataAvailable(): boolean;
  setRootList(template: CarPlayListTemplate): Promise<void>;
  setRootTabs(templates: CarPlayListTemplate[]): Promise<void>;
  selectTab(templateId: string): Promise<void>;
  pushList(template: CarPlayListTemplate, animated: boolean): Promise<void>;
  updateList(template: CarPlayListTemplate): Promise<void>;
  popTemplate(animated: boolean): Promise<void>;
  popToRoot(animated: boolean): Promise<void>;
  pushNowPlaying(animated: boolean): Promise<void>;
  configureNowPlaying(config: CarPlayNowPlayingConfig): Promise<void>;
  finishSelection(selectionId: string): Promise<void>;
  addListener(
    eventName: "onConnect" | "onDisconnect",
    listener: () => void,
  ): EventSubscription;
  addListener(
    eventName: "onSelect",
    listener: (event: CarPlaySelectEvent) => void,
  ): EventSubscription;
  addListener(
    eventName: "onNowPlayingButton",
    listener: (event: CarPlayNowPlayingButtonEvent) => void,
  ): EventSubscription;
  addListener(
    eventName:
      | "onNowPlayingUpNext"
      | "onNowPlayingAlbumArtist"
      | "onProtectedDataAvailable",
    listener: () => void,
  ): EventSubscription;
};
