/** Formats a duration in seconds as 12:34 or 1:02:03. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

/** Formats a byte rate as a compact human string, e.g. "1.2 Mbps". */
export function formatBitrate(bitsPerSecond: number | null | undefined): string {
  if (bitsPerSecond === null || bitsPerSecond === undefined || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '—';
  if (bitsPerSecond >= 1_000_000) return (bitsPerSecond / 1_000_000).toFixed(1) + ' Mbps';
  if (bitsPerSecond >= 1_000) return Math.round(bitsPerSecond / 1_000) + ' kbps';
  return Math.round(bitsPerSecond) + ' bps';
}

/** Formats seconds with up to three decimals as ms/s. */
export function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1) return value.toFixed(0) + ' s';
  if (value >= 0.1) return value.toFixed(2) + ' s';
  return Math.round(value * 1000) + ' ms';
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return (value * 100).toFixed(1) + '%';
}

export function formatResolution(width: number | null | undefined, height: number | null | undefined): string {
  if (width === null || width === undefined || !width || height === null || height === undefined || !height) return '—';
  return `${width}×${height}`;
}

/** Full-width username initial, safe for CJK names too. */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0].toUpperCase();
}
