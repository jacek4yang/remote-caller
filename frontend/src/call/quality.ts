export interface QualityTier {
  name: string;
  maxBitrate: number;
  maxFramerate: number;
  scale: number;
  width: number;
  height: number;
}

// Preserve HD spatial detail first and reduce temporal detail/bitrate before resolution.
export const QUALITY_TIERS: readonly QualityTier[] = [
  { name: '1080P 60FPS 极清', maxBitrate: 8_000_000, maxFramerate: 60, scale: 1, width: 1920, height: 1080 },
  { name: '1080P 45FPS 超清', maxBitrate: 5_500_000, maxFramerate: 45, scale: 1, width: 1920, height: 1080 },
  { name: '1080P 30FPS 高清', maxBitrate: 3_500_000, maxFramerate: 30, scale: 1, width: 1920, height: 1080 },
  { name: '720P 30FPS 弱网保护', maxBitrate: 1_800_000, maxFramerate: 30, scale: 1.5, width: 1280, height: 720 },
];

export function ewma(previous: number | null, current: number, alpha: number): number {
  if (!Number.isFinite(current)) return previous ?? current;
  return previous == null || !Number.isFinite(previous) ? current : previous + alpha * (current - previous);
}

export function classifyNetwork(loss: number, rtt: number, available: number): number {
  if (loss >= .12 || rtt >= .8 || available < 2_200_000) return 3;
  if (loss >= .07 || rtt >= .5 || available < 4_000_000) return 2;
  if (loss >= .03 || rtt >= .3 || available < 6_500_000) return 1;
  return 0;
}
