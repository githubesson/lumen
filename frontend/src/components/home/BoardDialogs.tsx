import { useState, type ComponentType } from "react";
import {
  Activity as ActivityIcon,
  ChartColumn as StatsIcon,
  Check as CheckIcon,
  Clock as RecentIcon,
  Disc3 as AlbumIcon,
  Eye as EyeIcon,
  Heart as HeartIcon,
  LibraryBig as AlbumsIcon,
  ListMusic as PlaylistIcon,
  ListPlus as PlaylistsIcon,
  MicVocal as ArtistIcon,
  Play as ResumeIcon,
  Plus as PlusIcon,
  Repeat as RepeatIcon,
  Sparkles as AddedIcon,
  Tags as GenreIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import type { Playlist } from "../../api";
import { Button } from "../Button";
import DialogFooter from "../DialogFooter";
import { DialogShell } from "../DialogShell";
import { Field, FieldRow, TextInput } from "../Field";
import { Select, type SelectOption } from "../Select";
import { usePopKey } from "../../lib/useTransitionMount";
import { pluralize } from "../../lib/format";
import { buildPeriodOptions, parsePeriodKey, periodKey, periodLabel, type Period } from "@music-library/core/replay/period";
import {
  MAX_PANELS,
  MAX_TITLE_LENGTH,
  canAdd,
  cleanTitle,
  type HomeArrangement,
  type HomePanel,
  type PanelChange,
} from "./homeArrangement";
import {
  DEFAULT_PERIOD,
  PANEL_HEIGHTS,
  PANEL_HEIGHT_LABELS,
  PANEL_KINDS,
  PANEL_KIND_IDS,
  PANEL_WIDTHS,
  PANEL_WIDTH_LABELS,
  allowsMany,
  type PanelGroup,
  type PanelHeight,
  type PanelKind,
  type PanelWidth,
} from "./panelKinds";

/**
 * The dialogs customizing Home opens: the panels to add, one panel's
 * settings, and the check before Reset throws away added panels.
 */

const KIND_ICONS: Record<PanelKind, ComponentType<{ className?: string }>> = {
  resume: ResumeIcon,
  repeat: RepeatIcon,
  artists: ArtistIcon,
  "top-albums": AlbumIcon,
  stats: StatsIcon,
  genres: GenreIcon,
  activity: ActivityIcon,
  recent: RecentIcon,
  favorites: HeartIcon,
  added: AddedIcon,
  albums: AlbumsIcon,
  playlists: PlaylistsIcon,
  playlist: PlaylistIcon,
};

const GROUPS: [PanelGroup, string][] = [
  ["listening", "Your listening"],
  ["library", "Your library"],
];

/** The periods a panel can show: the evergreen ones, past years with plays, all time. */
function periodOptions(years: readonly number[], current?: Period): SelectOption[] {
  const periods = buildPeriodOptions([...years]);
  // A saved year the server no longer lists stays pickable while it's set.
  if (current && !periods.some((p) => periodKey(p) === periodKey(current))) periods.splice(periods.length - 1, 0, current);
  return periods.map((period) => ({ value: periodKey(period), label: periodLabel(period) }));
}

const playlistOptions = (playlists: readonly Playlist[]): SelectOption[] =>
  playlists.map((playlist) => ({ value: playlist.id, label: playlist.name }));

export function AddPanelDialog({
  open,
  arrangement,
  playlists,
  years,
  onAdd,
  onClose,
}: {
  open: boolean;
  arrangement: HomeArrangement;
  playlists: readonly Playlist[];
  years: readonly number[];
  onAdd: (kind: PanelKind, options: Pick<HomePanel, "period" | "playlist">) => void;
  onClose: () => void;
}) {
  const openKey = usePopKey(open);
  const full = arrangement.panels.length >= MAX_PANELS;
  return (
    <DialogShell open={open} title="Add a panel" onClose={onClose} maxWidth={600}>
      <div key={openKey} className="board-catalog">
        {full && (
          <p className="board-catalog-note" role="status">
            Home has {MAX_PANELS} panels, as many as it holds. Remove one to add another.
          </p>
        )}
        {GROUPS.map(([group, label]) => (
          <section key={group} aria-label={label}>
            <h3 className="board-catalog-heading">{label}</h3>
            <ul className="board-catalog-list">
              {PANEL_KIND_IDS.filter((kind) => PANEL_KINDS[kind].group === group).map((kind) => (
                <CatalogRow
                  key={kind}
                  kind={kind}
                  arrangement={arrangement}
                  playlists={playlists}
                  years={years}
                  onAdd={onAdd}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </DialogShell>
  );
}

function CatalogRow({
  kind,
  arrangement,
  playlists,
  years,
  onAdd,
}: {
  kind: PanelKind;
  arrangement: HomeArrangement;
  playlists: readonly Playlist[];
  years: readonly number[];
  onAdd: (kind: PanelKind, options: Pick<HomePanel, "period" | "playlist">) => void;
}) {
  const info = PANEL_KINDS[kind];
  const Icon = KIND_ICONS[kind];
  const existing = allowsMany(kind) ? undefined : arrangement.panels.find((panel) => panel.kind === kind);
  const [period, setPeriod] = useState(periodKey(DEFAULT_PERIOD));
  // The first playlist not on Home yet, or the first.
  const [playlist, setPlaylist] = useState(() => {
    const onHome = new Set(arrangement.panels.map((panel) => panel.playlist));
    return (playlists.find((p) => !onHome.has(p.id)) ?? playlists[0])?.id ?? "";
  });
  const options = {
    ...(info.period ? { period: parsePeriodKey(period) ?? DEFAULT_PERIOD } : {}),
    ...(info.playlist ? { playlist } : {}),
  };

  let action;
  if (existing && !existing.hidden) {
    action = (
      <span className="board-catalog-on">
        <CheckIcon className="size-3.5" aria-hidden="true" />
        On Home
      </span>
    );
  } else if (existing) {
    action = (
      <Button size="sm" onClick={() => onAdd(kind, {})} leadingIcon={<EyeIcon className="size-3.5" />} aria-label={`Show ${info.title}`}>
        Show
      </Button>
    );
  } else {
    action = (
      <Button
        size="sm"
        variant="primary"
        disabled={!canAdd(arrangement, kind) || (info.playlist && !playlist)}
        onClick={() => onAdd(kind, options)}
        leadingIcon={<PlusIcon className="size-3.5" />}
        aria-label={`Add ${info.title}`}
      >
        Add
      </Button>
    );
  }

  return (
    <li className="board-catalog-row">
      <span className="board-catalog-icon" aria-hidden="true">
        <Icon className="size-4" />
      </span>
      <div className="board-catalog-text">
        <div className="board-catalog-title">{info.title}</div>
        <div className="board-catalog-desc">{info.description}</div>
      </div>
      <div className="board-catalog-actions">
        {info.period && !existing && (
          <Select
            variant="minimal"
            aria-label={`Period for ${info.title}`}
            value={period}
            options={periodOptions(years)}
            onChange={setPeriod}
          />
        )}
        {info.playlist &&
          (playlists.length > 0 ? (
            <Select
              variant="minimal"
              aria-label="Playlist for the new Playlist panel"
              value={playlist}
              options={playlistOptions(playlists)}
              onChange={setPlaylist}
            />
          ) : (
            <span className="board-catalog-desc">No playlists yet</span>
          ))}
        {action}
      </div>
    </li>
  );
}

export function PanelSettingsDialog({
  open,
  panel,
  title,
  playlists,
  years,
  onChange,
  onRemove,
  onClose,
}: {
  open: boolean;
  panel: HomePanel | undefined;
  /** Its title now, which the dialog's names it by. */
  title: string;
  playlists: readonly Playlist[];
  years: readonly number[];
  onChange: (change: PanelChange) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const openKey = usePopKey(open);
  // The panel it was opened for, kept through the closing fade.
  const [shown, setShown] = useState<{ panel: HomePanel; title: string } | null>(null);
  if (panel && (shown?.panel !== panel || shown.title !== title)) setShown({ panel, title });
  // A name being typed, saved as the dialog closes rather than on every key.
  const [name, setName] = useState<string | null>(null);
  const commit = () => {
    if (name !== null && shown && cleanTitle(name) !== shown.panel.title) onChange({ title: name });
  };
  const close = () => {
    commit();
    setName(null);
    onClose();
  };
  return (
    <DialogShell
      open={open}
      title={shown ? `Edit ${shown.title}` : "Edit panel"}
      onClose={close}
      maxWidth={480}
      footer={
        <DialogFooter
          start={
            <Button
              variant="ghost"
              onClick={() => {
                setName(null);
                onRemove();
              }}
              leadingIcon={<TrashIcon className="size-3.5" />}
            >
              Remove panel
            </Button>
          }
        >
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      }
    >
      {shown && (
        <PanelSettings
          key={`${shown.panel.id}:${openKey}`}
          panel={shown.panel}
          playlists={playlists}
          years={years}
          name={name ?? shown.panel.title ?? ""}
          onName={setName}
          onCommitName={commit}
          onChange={onChange}
        />
      )}
    </DialogShell>
  );
}

function PanelSettings({
  panel,
  playlists,
  years,
  name,
  onName,
  onCommitName,
  onChange,
}: {
  panel: HomePanel;
  playlists: readonly Playlist[];
  years: readonly number[];
  name: string;
  onName: (name: string) => void;
  onCommitName: () => void;
  onChange: (change: PanelChange) => void;
}) {
  const info = PANEL_KINDS[panel.kind];
  // A stacked board (a phone) has no sizes to pick.
  const [narrow] = useState(() => {
    const board = document.querySelector<HTMLElement>(".board-view");
    return !!board && board.clientWidth > 0 && board.clientWidth < 560;
  });
  const placeholder =
    panel.kind === "playlist" ? (playlists.find((p) => p.id === panel.playlist)?.name ?? info.title) : info.title;

  return (
    <form
      className="board-settings"
      onSubmit={(e) => {
        e.preventDefault();
        onCommitName();
      }}
    >
      <Field label="Name">
        <TextInput
          value={name}
          placeholder={placeholder}
          maxLength={MAX_TITLE_LENGTH}
          onChange={(e) => onName(e.target.value)}
          onBlur={onCommitName}
        />
      </Field>
      {info.period && (
        <Field label="Shows">
          <Select
            value={periodKey(panel.period ?? DEFAULT_PERIOD)}
            options={periodOptions(years, panel.period)}
            onChange={(key) => onChange({ period: parsePeriodKey(key) ?? DEFAULT_PERIOD })}
          />
        </Field>
      )}
      {info.playlist && (
        <Field label="Playlist">
          <Select
            value={panel.playlist ?? ""}
            options={playlistOptions(playlists)}
            placeholder="Pick a playlist"
            onChange={(playlist) => onChange({ playlist })}
          />
        </Field>
      )}
      {!narrow && (
        <FieldRow>
          <Field label="Width">
            <Select
              value={String(panel.w)}
              options={PANEL_WIDTHS.map((w) => ({ value: String(w), label: PANEL_WIDTH_LABELS[w] }))}
              onChange={(w) => onChange({ w: Number(w) as PanelWidth })}
            />
          </Field>
          <Field label="Height">
            <Select
              value={String(panel.h)}
              options={PANEL_HEIGHTS.map((h) => ({ value: String(h), label: PANEL_HEIGHT_LABELS[h] }))}
              onChange={(h) => onChange({ h: Number(h) as PanelHeight })}
            />
          </Field>
        </FieldRow>
      )}
    </form>
  );
}

export function ResetBoardDialog({
  open,
  added,
  onReset,
  onClose,
}: {
  open: boolean;
  /** The titles of the panels the user added, which a reset removes. */
  added: string[];
  onReset: () => void;
  onClose: () => void;
}) {
  // Kept through the closing fade.
  const [shown, setShown] = useState(added);
  if (open && added.join("\n") !== shown.join("\n")) setShown(added);
  const names = new Intl.ListFormat(undefined, { type: "conjunction" }).format(shown);
  return (
    <DialogShell
      open={open}
      title="Reset Home?"
      onClose={onClose}
      maxWidth={440}
      footer={
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onReset} leadingIcon={<TrashIcon className="size-3.5" />}>
            Reset Home
          </Button>
        </DialogFooter>
      }
    >
      <div className="board-reset">
        <p>
          Home goes back to its usual panels and layout, and the {pluralize(shown.length, "panel")} you added (
          {names}) {shown.length === 1 ? "is" : "are"} removed.
        </p>
      </div>
    </DialogShell>
  );
}
