import { readVideo } from "./parse";
import { S } from "./selectors";
import { sleep } from "./util";

export type PlayResult =
  | { ok: true }
  | { ok: false; reason: "no_player" | "play_blocked" | "stalled" | "no_continue" | "aborted" };

// Real-time playback only: never touches playbackRate, currentTime or muted.
export async function playToEnd(
  doc: Document, signal: AbortSignal, onProgress?: (t: number, d: number) => void,
): Promise<PlayResult> {
  let info = readVideo(doc);
  for (let i = 0; i < 40 && !info; i++) {
    if (signal.aborted) return { ok: false, reason: "aborted" };
    await sleep(500);
    info = readVideo(doc);
  }
  if (!info) return { ok: false, reason: "no_player" };
  const { video } = info;
  // The site resumes at the last position (e.g. after a skip) and only credits a play from the start.
  if (video.currentTime > 1 || video.ended) video.currentTime = 0;
  if (video.paused && !video.ended) {
    try { await video.play(); } catch { return { ok: false, reason: "play_blocked" }; }
  }
  const deadline = Date.now() + (info.duration + 45) * 1000;
  let last = video.currentTime, stalls = 0, since = Date.now();
  while (!video.ended) {
    if (signal.aborted) return { ok: false, reason: "aborted" };
    if (Date.now() > deadline) return { ok: false, reason: "stalled" };
    await sleep(250);
    onProgress?.(video.currentTime, info.duration);
    if (Date.now() - since >= 5000) {
      if (video.currentTime - last < 2) {
        if (++stalls >= 3) return { ok: false, reason: "stalled" };
        video.play().catch(() => {});
      } else stalls = 0;
      last = video.currentTime; since = Date.now();
    }
  }
  for (let i = 0; i < 100; i++) {
    if (doc.querySelector(S.continueBtn)) return { ok: true };
    await sleep(100);
  }
  return { ok: false, reason: "no_continue" };
}
