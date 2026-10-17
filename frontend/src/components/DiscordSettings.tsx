import { useCallback, useEffect, useId, useRef, useState } from "react";
import { buildNowPlayingMetadata, type TrackListItem } from "@music-library/core";
import {
  DEFAULT_DISCORD_CARD,
  discordCardLines,
  type DiscordCardFields,
} from "../../electron/discord-card";
import { trackCoverUrl } from "../api";
import { useAuth } from "../context/Auth";
import { usePlayer, usePlayerTime } from "../context/Player";
import type { DiscordCardOptions } from "../electron";
import { updateDesktopConfig } from "../lib/desktopConfig";
import BrandMark from "./BrandMark";
import { Button } from "./Button";
import type { DesktopSettingsState } from "./DesktopSettings";
import { Select, type SelectOption } from "./Select";
import SettingRow from "./SettingRow";
import Switch from "./Switch";

const STATUS_NAMES: SelectOption<DiscordCardOptions["statusName"]>[] = [
  { value: "app", label: "Lumen" },
  { value: "details", label: "Line 1" },
  { value: "state", label: "Line 2" },
];

const LINES = [
  { key: "details", label: "Line 1" },
  { key: "state", label: "Line 2" },
  { key: "largeText", label: "Line 3" },
] as const;

// Shown in the preview while nothing is loaded.
const SAMPLE: DiscordCardFields = { title: "Track title", artist: "Artist", album: "Album" };

/** Typing waits this long for a pause before the card is saved and redrawn. */
const TYPING_SAVE_MS = 600;

/**
 * The Discord card's options: a live preview of the card and the member list
 * line, the three lines' templates and the cover/badge/paused switches. Edits
 * show in the preview at once and save as they're made (typing after a
 * pause), and the desktop app redraws the card in Discord when they land.
 */
export function DiscordCardSettings({ desktop }: { desktop: DesktopSettingsState }) {
  const saved = desktop.config.discordCard;
  const [card, setCard] = useState(saved);
  const [error, setError] = useState<string>();
  const latest = useRef(card);
  // Options changed since the last save; only these are sent.
  const unsaved = useRef<Partial<DiscordCardOptions> | null>(null);
  const saving = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();

  // Saved options that change while nothing here is waiting or saving (an
  // earlier mount's save landing after a remount, say) replace the draft.
  useEffect(() => {
    if (unsaved.current || saving.current) return;
    latest.current = saved;
    setCard(saved);
  }, [saved]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const changes = unsaved.current;
    unsaved.current = null;
    if (!changes) return;
    saving.current += 1;
    void updateDesktopConfig({ discordCard: changes })
      .catch((cause: unknown) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : "Could not save.",
      }))
      .then((result) => {
        saving.current -= 1;
        if (!result.ok) {
          // Keep what didn't save for the next save (an edit, blur or
          // closing), at its newest value: only changed options go out.
          const retry = Object.fromEntries(
            Object.keys(changes).map((key) => [key, latest.current[key as keyof DiscordCardOptions]]),
          );
          unsaved.current = { ...unsaved.current, ...retry };
          setError(result.error);
          return;
        }
        // The message stays until nothing that failed is left to save.
        if (!unsaved.current) setError(undefined);
        // Once idle, show the card as saved, with any other save merged in.
        if (!saving.current && !unsaved.current) {
          latest.current = result.config.discordCard;
          setCard(result.config.discordCard);
        }
      });
  }, []);
  // Leaving the section or closing Settings saves what was typed last.
  useEffect(() => flush, [flush]);

  const change = (patch: Partial<DiscordCardOptions>, typing = false) => {
    latest.current = { ...latest.current, ...patch };
    unsaved.current = { ...unsaved.current, ...patch };
    setCard(latest.current);
    clearTimeout(timer.current);
    if (typing) timer.current = setTimeout(flush, TYPING_SAVE_MS);
    else flush();
  };

  const isDefault = (Object.keys(DEFAULT_DISCORD_CARD) as (keyof DiscordCardOptions)[]).every(
    (key) => card[key] === DEFAULT_DISCORD_CARD[key],
  );

  return (
    <>
      <div className="settings-row">
        <DiscordCardPreview card={card} />
      </div>
      <SettingRow
        id={`${id}-lines`}
        label="Card text"
        description="{title}, {artist} and {album} fill in with the track's."
        below={
          <div className="discord-lines">
            {LINES.map(({ key, label }) => (
              <label key={key} className="discord-line">
                <span className="discord-line-label">{label}</span>
                <input
                  className="input settings-input"
                  placeholder="Hidden"
                  spellCheck={false}
                  maxLength={128}
                  value={card[key]}
                  onChange={(e) => change({ [key]: e.currentTarget.value }, true)}
                  onBlur={flush}
                />
              </label>
            ))}
          </div>
        }
      />
      <SettingRow
        id={`${id}-status`}
        label="Status text"
        description="What follows “Listening to” in the member list."
      >
        <Select
          variant="minimal"
          aria-labelledby={`${id}-status-label`}
          value={card.statusName}
          options={STATUS_NAMES}
          onChange={(statusName) => change({ statusName })}
        />
      </SettingRow>
      <CardSwitch
        label="Album cover"
        description="Off shows the Lumen logo instead."
        checked={card.cover}
        onChange={(cover) => change({ cover })}
      />
      <CardSwitch
        label="Play/pause badge"
        description="The small icon on the cover's corner."
        checked={card.playState}
        onChange={(playState) => change({ playState })}
      />
      <CardSwitch
        label="Show while paused"
        description="Off clears your status until you press play again."
        checked={card.showPaused}
        onChange={(showPaused) => change({ showPaused })}
      />
      {(!isDefault || error) && (
        <SettingRow
          label="Reset card"
          description="Back to title, artist and album, with the cover and badge."
          error={error}
        >
          {!isDefault && (
            <Button size="sm" onClick={() => change(DEFAULT_DISCORD_CARD)}>
              Reset
            </Button>
          )}
        </SettingRow>
      )}
    </>
  );
}

function CardSwitch({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <SettingRow id={id} label={label} description={description}>
      <Switch
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-desc`}
        checked={checked}
        onChange={onChange}
      />
    </SettingRow>
  );
}

/**
 * Your Discord profile popout as the default client draws it (dark theme),
 * with the card for the track that's playing (or a sample), and the member
 * list row the status text shows in. Measured off real Discord: its own
 * colours and fonts, not the app theme's, so it reads as Discord's.
 */
function DiscordCardPreview({ card }: { card: DiscordCardOptions }) {
  const { current, isPlaying } = usePlayer();
  const { me } = useAuth();
  const text = buildNowPlayingMetadata(current);
  const fields = text
    ? { title: text.title, artist: text.artist, album: text.albumTitle }
    : SAMPLE;
  const lines = discordCardLines(card, fields);
  const playing = isPlaying || !current;
  const hidden = !playing && !card.showPaused;
  const status =
    (card.statusName === "details" ? lines.details : card.statusName === "state" ? lines.state : undefined) ??
    "Lumen";
  const name = me?.username ?? "you";

  return (
    <figure className="discord-preview" aria-label="Preview of your Discord profile and status">
      <div className="discord-popout">
        <div className="discord-banner">
          <span className="discord-banner-more" aria-hidden="true">
            <MoreDots />
          </span>
        </div>
        <div className="discord-popout-body">
          <DiscordAvatar className="discord-popout-avatar" />
          <div className="discord-status-bubble" aria-hidden="true">
            <svg viewBox="0 0 16 16" className="discord-status-bubble-add">
              <circle cx="8" cy="8" r="8" fill="currentColor" />
              <path d="M8 4.5v7M4.5 8h7" stroke="var(--discord-bubble)" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
            Most used emoji lately?
          </div>
          <div className="discord-popout-name">{name}</div>
          <div className="discord-popout-username">{name.toLowerCase()}</div>
          {!hidden && (
            <div className="discord-card">
              <div className="discord-card-head">
                <span>Listening to Lumen</span>
                <MoreDots />
              </div>
              <div className="discord-card-body">
                <PreviewArt track={current} card={card} isPlaying={playing} title={lines.largeText} />
                <div className="discord-card-text">
                  {lines.details && <div className="discord-card-details">{lines.details}</div>}
                  {lines.state && <div className="discord-card-line discord-card-state">{lines.state}</div>}
                  {lines.largeText && <div className="discord-card-line">{lines.largeText}</div>}
                  {!current ? (
                    <PreviewTimeBar currentTime={84} duration={192} />
                  ) : isPlaying ? (
                    <PreviewTime />
                  ) : (
                    <PreviewSessionTime />
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="discord-edit-profile" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z" />
            </svg>
            Edit Profile
          </div>
        </div>
      </div>
      <div className="discord-member">
        <DiscordAvatar className="discord-member-avatar" />
        <span className="discord-member-text">
          <span className="discord-member-name">{name}</span>
          {!hidden && (
            <span className="discord-member-status">
              Listening to <strong>{status}</strong>
            </span>
          )}
        </span>
      </div>
    </figure>
  );
}

/** Discord's default avatar, with the online dot. */
function DiscordAvatar({ className }: { className: string }) {
  return (
    <span className={`discord-avatar ${className}`} aria-hidden="true">
      <DiscordIcon className="discord-avatar-logo" />
      <span className="discord-avatar-status" />
    </span>
  );
}

function MoreDots() {
  return (
    <svg viewBox="0 0 13 3" className="discord-more-dots" aria-hidden="true">
      <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
      <circle cx="6.5" cy="1.5" r="1.5" fill="currentColor" />
      <circle cx="11.5" cy="1.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

function PreviewArt({
  track,
  card,
  isPlaying,
  title,
}: {
  track: TrackListItem | null;
  card: DiscordCardOptions;
  isPlaying: boolean;
  title?: string;
}) {
  const src = card.cover && track ? trackCoverUrl(track) : null;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className="discord-card-art" title={title}>
      {src && failed !== src ? (
        <img src={src} alt="" onError={() => setFailed(src)} />
      ) : (
        <BrandMark />
      )}
      {card.playState && (
        <span className="discord-card-badge" aria-hidden="true">
          {isPlaying ? (
            <svg viewBox="0 0 16 20" width="16" height="20" fill="currentColor">
              <path d="M0 0 16 10 0 20Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 14" width="10" height="14" fill="currentColor">
              <path d="M0 0h3v14H0ZM7 0h3v14H7Z" />
            </svg>
          )}
        </span>
      )}
    </div>
  );
}

/** Discord's clock: minutes always two digits ("00:08"), hours only when needed. */
function discordClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/** A playing track with a known length gets Discord's time bar. */
function PreviewTime() {
  const { currentTime, duration } = usePlayerTime();
  if (!(duration > 0)) return null;
  return <PreviewTimeBar currentTime={currentTime} duration={duration} />;
}

function PreviewTimeBar({ currentTime, duration }: { currentTime: number; duration: number }) {
  const progress = Math.min(1, Math.max(0, currentTime / duration));
  return (
    <div className="discord-card-time">
      <span>{discordClock(currentTime)}</span>
      <span className="discord-card-bar">
        <span style={{ width: `${progress * 100}%` }} />
      </span>
      <span>{discordClock(duration)}</span>
    </div>
  );
}

/**
 * Paused, Lumen sends no times and Discord shows its own clock instead, which
 * seems to count from when the status first went up. The app's start stands
 * in for that here.
 */
function PreviewSessionTime() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="discord-card-time discord-card-session">
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M14 1.5v9.25a2.75 2.75 0 1 1-1.5-2.45V4.6L6.5 5.9v6.85A2.75 2.75 0 1 1 5 10.3V3.3Z" />
      </svg>
      <span>{discordClock((now - performance.timeOrigin) / 1000)}</span>
    </div>
  );
}

/** Discord's logo, for the Settings section list (Lucide has no brand icons). */
export function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.85a13.9 13.9 0 0 0-.63 1.29 18.4 18.4 0 0 0-5.53 0 12.6 12.6 0 0 0-.64-1.29 19.7 19.7 0 0 0-4.93 1.52C.54 9.05-.32 13.6.1 18.09a19.9 19.9 0 0 0 6.07 3.06c.49-.66.92-1.37 1.3-2.1a12.9 12.9 0 0 1-2.04-.98c.17-.13.34-.26.5-.39a14.2 14.2 0 0 0 12.14 0c.17.14.33.27.5.39-.65.39-1.33.71-2.05.98.38.74.81 1.44 1.3 2.1a19.8 19.8 0 0 0 6.08-3.06c.5-5.2-.84-9.72-3.58-13.72ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.22 0 2.18 1.1 2.16 2.42 0 1.34-.94 2.42-2.16 2.42Z" />
    </svg>
  );
}
