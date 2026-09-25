import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Download as DownloadIcon,
  Link2 as LinkIcon,
  Monitor as MonitorIcon,
  Palette as PaletteIcon,
  Volume2 as SpeakerIcon,
  X as XMarkIcon,
  type LucideIcon,
} from "lucide-react";
import { useLastFMConnection } from "@music-library/core";
import { useTheme, type Density, type Layout, type Theme } from "../context/Theme";
import { useAudioOutput } from "../lib/audioOutput";
import { useKey, useModalKeyScope } from "../lib/keybindings";
import { openExternal } from "../lib/platform";
import { useTransitionMount } from "../lib/useTransitionMount";
import { Button } from "./Button";
import { ServerSetting, ToggleSetting, useDesktopSettings } from "./DesktopSettings";
import DesktopUpdates, { useDesktopUpdates } from "./DesktopUpdates";
import SearchInput from "./SearchInput";
import { Select, type SelectOption } from "./Select";
import SettingRow from "./SettingRow";

export type SectionId = "appearance" | "playback" | "desktop" | "connections" | "updates";

interface Props {
  open: boolean;
  /** Section to show on opening; otherwise the last one viewed. */
  section?: SectionId;
  onClose: () => void;
}

interface SettingDef {
  id: string;
  /** Matched by the sidebar search, along with the section title. */
  keywords: string;
  render: () => ReactNode;
}

interface SectionDef {
  id: SectionId;
  title: string;
  icon: LucideIcon;
  settings: SettingDef[];
}

const THEMES: SelectOption<Theme>[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const RADII: SelectOption[] = [0, 4, 6, 10, 14, 20].map((r) => ({
  value: String(r),
  label: `${r}px`,
}));
const DENSITIES: SelectOption<Density>[] = [
  { value: "airy", label: "Airy" },
  { value: "balanced", label: "Balanced" },
  { value: "dense", label: "Dense" },
];
const LAYOUTS: SelectOption<Layout>[] = [
  { value: "compact", label: "Compact" },
  { value: "sidebar", label: "Sidebar" },
  { value: "wide", label: "Wide" },
];

/**
 * App settings as a modal with a searchable section list on the left and
 * label / control rows on the right. Replaces the old floating Tweaks panel,
 * which had outgrown a popover once audio output, Last.fm and desktop updates
 * moved in. The desktop app's server and window options live here too.
 */
export default function SettingsDialog({ open, section, onClose }: Props) {
  const { mounted, visible } = useTransitionMount(open, 200);
  const titleId = useId();
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState<SectionId>("appearance");
  const [query, setQuery] = useState("");

  const {
    theme,
    radius,
    density,
    layout,
    setTheme,
    setRadius,
    setDensity,
    setLayout,
  } = useTheme();
  const audioOut = useAudioOutput();
  const {
    status: lastFM,
    busy: lastFMBusy,
    error: lastFMError,
    connect: connectLastFM,
    disconnect: disconnectLastFM,
  } = useLastFMConnection({
    enabled: open,
    openAuthorization: async (url) => {
      const opened = await openExternal(url);
      if (!opened.ok) {
        throw new Error(opened.error ?? "Could not open Last.fm authorization.");
      }
    },
  });
  // Interactive only while open. During the exit fade `mounted` is still true,
  // but keys, shortcuts, focus and in-flight updater work must already be
  // released (e.g. to the palette after a Mod-K handoff, or a quick reopen).
  const interactive = open && mounted;
  const updates = useDesktopUpdates(interactive);
  const desktop = useDesktopSettings(interactive);

  // Shell passes a fresh arrow each render; the effect below must only run on
  // mount/unmount or it would yank focus back to the panel on every render.
  const latest = useRef({ onClose, query });
  useEffect(() => {
    latest.current = { onClose, query };
  });

  useEffect(() => {
    if (!interactive) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    const layer = layerRef.current;
    const panel = panelRef.current;
    panel?.focus();
    // Capture phase, so Escape and Tab are settled here before anything behind
    // the scrim sees them. Other page shortcuts are off via useModalKeyScope.
    const onKeyDown = (event: KeyboardEvent) => {
      // An open Select owns Tab / Escape until it closes.
      if (event.target instanceof Element && event.target.closest('[role="listbox"]')) {
        return;
      }
      if (event.key === "Tab") {
        trapTab(event, panel);
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      // Escape backs out one step: a search, wherever focus is, then the dialog.
      if (latest.current.query) {
        // Clearing swaps the results for the section view, which would unmount
        // a focused result control; park focus on the search box first.
        searchRef.current?.focus();
        setQuery("");
      } else {
        latest.current.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      // If something else already took focus (e.g. Mod-K opened the palette),
      // leave it there.
      const now = document.activeElement;
      // The scrim counts as the dialog's own focus too.
      if (!now || now === document.body || layer?.contains(now)) restoreFocus(restoreTo);
    };
  }, [interactive]);

  // Page-level Mod-F would focus a search box behind the scrim; while Settings
  // is open it means this one.
  useKey(
    "mod+f",
    (e) => {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    { id: "settings:search", allowInInput: true, enabled: interactive, whileModal: true },
  );
  useModalKeyScope(interactive);

  // Start fresh each time the dialog opens, on the section asked for if any.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery("");
    if (section) setActive(section);
  }, [open, section]);

  const lastFMState = !lastFM
    ? "Checking…"
    : !lastFM.configured
      ? "Not set up on this server."
      : lastFM.connected
        ? `Scrobbling as ${lastFM.username || "your account"}.`
        : lastFM.pending
          ? "Waiting for you to approve Lumen on Last.fm."
          : "Send what you play to your Last.fm profile.";
  const lastFMErrorText = lastFMError || lastFM?.last_error;

  const sections: SectionDef[] = [
    {
      id: "appearance",
      title: "Appearance",
      icon: PaletteIcon,
      settings: [
        {
          id: "theme",
          keywords: "theme dark light mode color",
          render: () => (
            <SettingRow label="Theme">
              <Select
                variant="minimal"
                aria-label="Theme"
                value={theme}
                options={THEMES}
                onChange={setTheme}
              />
            </SettingRow>
          ),
        },
        {
          id: "radius",
          keywords: "corner radius rounded round",
          render: () => (
            <SettingRow
              label="Corner radius"
              description="How rounded cards, buttons and menus are."
            >
              <Select
                variant="minimal"
                aria-label="Corner radius"
                value={String(radius)}
                options={RADII}
                onChange={(r) => setRadius(Number(r))}
              />
            </SettingRow>
          ),
        },
        {
          id: "density",
          keywords: "density spacing airy balanced dense compact",
          render: () => (
            <SettingRow label="Density" description="Spacing between cards and rows.">
              <Select
                variant="minimal"
                aria-label="Density"
                value={density}
                options={DENSITIES}
                onChange={setDensity}
              />
            </SettingRow>
          ),
        },
        {
          id: "layout",
          keywords: "layout sidebar compact wide navigation",
          render: () => (
            <SettingRow label="Layout" description="How the sidebar and content are arranged.">
              <Select
                variant="minimal"
                aria-label="Layout"
                value={layout}
                options={LAYOUTS}
                onChange={setLayout}
              />
            </SettingRow>
          ),
        },
      ],
    },
    {
      id: "playback",
      title: "Playback",
      icon: SpeakerIcon,
      settings: audioOut.supported
        ? [
            {
              id: "output",
              keywords: "output device audio speaker headphones sound",
              render: () => (
                <SettingRow
                  label="Output device"
                  description="Where Lumen plays audio."
                  error={audioOut.error}
                >
                  <Select
                    variant="minimal"
                    aria-label="Audio output device"
                    value={audioOut.deviceId}
                    options={[
                      { value: "", label: "System default" },
                      ...audioOut.devices
                        .filter((d) => d.deviceId && d.deviceId !== "default")
                        .map((d) => ({ value: d.deviceId, label: d.label })),
                    ]}
                    onChange={(id) => void audioOut.selectDevice(id)}
                  />
                </SettingRow>
              ),
            },
          ]
        : [],
    },
    {
      id: "desktop",
      title: "Desktop",
      icon: MonitorIcon,
      settings: desktop
        ? [
            {
              id: "server",
              keywords: "server url address backend host change switch",
              render: () => <ServerSetting desktop={desktop} />,
            },
            {
              id: "always-on-top",
              keywords: "stay on top always window pin float",
              render: () => (
                <ToggleSetting
                  desktop={desktop}
                  setting="alwaysOnTop"
                  label="Stay on top"
                  description="Keep Lumen above other windows."
                />
              ),
            },
            {
              id: "fh6-radio",
              keywords: "lumen radio fh6 forza horizon game",
              render: () => (
                <ToggleSetting
                  desktop={desktop}
                  setting="fh6RadioEnabled"
                  label="Lumen Radio for FH6"
                  description="Adds the Forza Horizon 6 radio installer and controls to the sidebar."
                />
              ),
            },
          ]
        : [],
    },
    {
      id: "connections",
      title: "Connections",
      icon: LinkIcon,
      settings: [
        {
          id: "lastfm",
          keywords: "last.fm lastfm scrobbling scrobble connect account",
          render: () => (
            <SettingRow
              label="Last.fm scrobbling"
              description={lastFMState}
              error={lastFMErrorText}
            >
              {lastFM?.configured &&
                (lastFM.connected ? (
                  <Button
                    size="sm"
                    disabled={lastFMBusy}
                    onClick={() => void disconnectLastFM()}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={lastFMBusy}
                    onClick={() => void connectLastFM()}
                  >
                    {lastFM.pending ? "Restart" : "Connect"}
                  </Button>
                ))}
            </SettingRow>
          ),
        },
        ...(desktop
          ? [
              {
                id: "discord",
                keywords: "discord rich presence status listening activity",
                render: () => (
                  <ToggleSetting
                    desktop={desktop}
                    setting="discordEnabled"
                    label="Discord status"
                    description="Show what you're listening to. Needs the Discord app running."
                  />
                ),
              },
            ]
          : []),
      ],
    },
    {
      id: "updates",
      title: "Updates",
      icon: DownloadIcon,
      settings: updates
        ? [
            {
              id: "desktop-updates",
              keywords: "desktop updates update channel branch main dev source repository status check install",
              render: () => <DesktopUpdates updates={updates} />,
            },
          ]
        : [],
    },
  ].filter((s) => s.settings.length > 0) as SectionDef[];

  // Every query word must start some word of the section title or keywords,
  // so "de" finds density / device / dev but not "mode".
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = terms.length
    ? sections
        .map((s) => ({
          ...s,
          settings: s.settings.filter((st) => {
            const words = `${s.title} ${st.keywords}`.toLowerCase().split(/\s+/);
            return terms.every((t) => words.some((w) => w.startsWith(t)));
          }),
        }))
        .filter((s) => s.settings.length > 0)
    : null;

  if (!mounted) return null;

  const current = sections.find((s) => s.id === active) ?? sections[0];
  const navSections = matches ?? sections;

  return (
    <div
      ref={layerRef}
      className="dialog-layer group fixed inset-0 grid place-items-center p-4 settings-layer"
      data-closed={!visible || undefined}
      // Fading out: no focus, clicks or Tab stops, so nothing lands in it.
      inert={open ? undefined : ""}
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        // Don't let a click focus the scrim; focus should go back to the opener.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        className="absolute inset-0 transition-opacity duration-200 ease-out group-data-closed:opacity-0"
        style={{ background: "var(--scrim)" }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="dialog settings relative transition-[opacity,transform] duration-200 ease-out group-data-closed:scale-95 group-data-closed:opacity-0 motion-reduce:transition-none motion-reduce:group-data-closed:scale-100"
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-top">
            <button
              type="button"
              className="iconbtn settings-close"
              aria-label="Close settings"
              onClick={onClose}
            >
              <XMarkIcon className="size-4" aria-hidden="true" />
            </button>
            <SearchInput
              ref={searchRef}
              className="settings-search"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <ul className="settings-nav-list">
            {navSections.map((s) => {
              const Icon = s.icon;
              const selected = !matches && s.id === current.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={"settings-nav-item" + (selected ? " active" : "")}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => {
                      setQuery("");
                      setActive(s.id);
                    }}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    <span>{s.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="settings-pane dialog-scroll">
          {matches ? (
            <>
              <h2 id={titleId} className="settings-heading">
                Search results
              </h2>
              {matches.length === 0 ? (
                <p className="settings-empty">No settings match “{query.trim()}”.</p>
              ) : (
                matches.map((s) => (
                  <section key={s.id} className="settings-group">
                    <h3 className="settings-subheading">{s.title}</h3>
                    {s.settings.map((st) => (
                      <Fragment key={st.id}>{st.render()}</Fragment>
                    ))}
                  </section>
                ))
              )}
            </>
          ) : (
            <>
              <h2 id={titleId} className="settings-heading">
                {current.title}
              </h2>
              {current.settings.map((st) => (
                <Fragment key={st.id}>{st.render()}</Fragment>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab cycling inside the dialog instead of the app behind it. */
function trapTab(event: KeyboardEvent, panel: HTMLElement | null) {
  if (!panel) return;
  const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
  if (items.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const current = document.activeElement;
  const inside = current instanceof Node && panel.contains(current);
  if (event.shiftKey && (!inside || current === first || current === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || current === last)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Return focus to the element that opened the dialog. If it can't take focus
 * (it was hidden, like the mobile drawer that closes as Settings opens, or it
 * is gone, like a command palette item), fall back to a visible Settings
 * trigger, or the control that reveals one (e.g. the mobile menu button).
 */
function restoreFocus(target: HTMLElement | null) {
  const candidates = [
    target,
    ...document.querySelectorAll<HTMLElement>("[data-settings-trigger]"),
  ];
  for (const el of candidates) {
    if (el && el !== document.body && focusOrOpener(el)) return;
  }
}

/** Focus `el`, or the visible `aria-controls` opener of a hidden container around it. */
function focusOrOpener(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  el.focus();
  if (document.activeElement === el) return true;
  for (let box = el.parentElement; box; box = box.parentElement) {
    if (!box.id) continue;
    const opener = [
      ...document.querySelectorAll<HTMLElement>(`[aria-controls="${CSS.escape(box.id)}"]`),
    ].find((c) => c.getClientRects().length > 0);
    if (opener) {
      opener.focus();
      return document.activeElement === opener;
    }
  }
  return false;
}
