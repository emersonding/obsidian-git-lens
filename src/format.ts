import { BlameLine, DateStyle } from "./types";

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/** Format a commit's author time according to the configured style. */
export function formatDate(epochSeconds: number, style: DateStyle): string {
  if (style === "absolute") return formatAbsolute(epochSeconds);
  return formatAge(epochSeconds);
}

/** "2024-01-30" in local time. */
export function formatAbsolute(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Full local date-time, used in popups/tooltips. */
export function formatDateTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

/** Compact relative age such as "3w", "6mo", "2y". */
export function formatAge(epochSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - epochSeconds);
  const mins = diff / 60;
  const hours = mins / 60;
  const days = hours / 24;
  const weeks = days / 7;
  const months = days / 30;
  const years = days / 365;

  if (hours < 1) return `${Math.max(1, Math.round(mins))}m`;
  if (days < 1) return `${Math.round(hours)}h`;
  if (days < 14) return `${Math.round(days)}d`;
  if (weeks < 9) return `${Math.round(weeks)}w`;
  if (months < 12) return `${Math.round(months)}mo`;
  return `${Math.round(years)}y`;
}

/**
 * Deterministic age-based tint for an annotation's left border.
 * Recent commits are green/warm; older ones fade toward grey-blue.
 */
export function ageColor(epochSeconds: number): string {
  const now = Date.now() / 1000;
  const days = Math.max(0, (now - epochSeconds) / 86400);
  const t = Math.min(1, days / 365); // 0 = today, 1 = a year or older
  const hue = Math.round(140 - 140 * t); // 140 (green) -> 0 (red-ish), via blue range
  const sat = Math.round(60 - 30 * t);
  const light = Math.round(45 + 12 * t);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

/** One-line tooltip for an annotation. */
export function tooltipText(blame: BlameLine): string {
  if (blame.isUncommitted) return "Uncommitted changes";
  return `${shortHash(blame.hash)} · ${blame.author} · ${formatAbsolute(blame.authorTime)}\n${blame.summary}`;
}
