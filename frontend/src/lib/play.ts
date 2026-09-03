/** Calls video.play() defensively: some environments (jsdom, older WebViews)
 *  do not implement play() or reject without a user gesture. */
export function safePlay(video: HTMLVideoElement | null): void {
  if (!video) return;
  try {
    const result = video.play();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Autoplay policy or unsupported API: the UI surfaces a resume hint.
  }
}
