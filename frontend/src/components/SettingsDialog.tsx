import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Download as DownloadIcon,
  Link2 as LinkIcon,
  Palette as PaletteIcon,
  Volume2 as SpeakerIcon,
  X as XMarkIcon,
  type LucideIcon,
} from "lucide-react";
import { useLastFMConnection } from "@music-library/core";
import { useTheme, type Density, type Layout, type Theme } from "../context/Theme";
import { useAudioOutput } from "../lib/audioOutput";
import { openExternal } from "../lib/platform";
import { useTransitionMount } from "../lib/useTransitionMount";
import { Button } from "./Button";
import DesktopUpdates from "./DesktopUpdates";
import SearchInput from "./SearchInput";
import { Select, type SelectOption } from "./Select";
import SettingRow from "./SettingRow";

interface Props {
  open: boolean;
  onClose: () => void;
}

type SectionId = "appearance" | "playback" | "connections" | "updates";

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
 * moved in.
 */
export default function SettingsDialog({ open, onClose }: Props) {
  const { mounted, visible } = useTransitionMount(open, 200);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
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
  const hasDesktopUpdates = !!window.electron?.getUpdateStatus;

  // Shell passes a fresh arrow each render; the effect below must only run on
  // mount/unmount or it would yank focus back to the panel on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!mounted) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // An open Select handles its own Escape (and marks it handled) first.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      restoreTo?.focus?.();
    };
  }, [mounted]);

  // Start fresh each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery("");
  }, [open]);

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
      ],
    },
    {
      id: "updates",
      title: "Updates",
      icon: DownloadIcon,
      settings: hasDesktopUpdates
        ? [
            {
              id: "desktop-updates",
              keywords: "desktop updates update channel branch main dev source repository check install",
              render: () => <DesktopUpdates />,
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
      className="dialog-layer group fixed inset-0 grid place-items-center p-4 settings-layer"
      data-closed={!visible || undefined}
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
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
          <button
            type="button"
            className="iconbtn settings-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            <XMarkIcon className="size-4" aria-hidden="true" />
          </button>
          <SearchInput
            className="settings-search"
            placeholder="Search settings"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onClear={query ? () => setQuery("") : undefined}
          />
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
