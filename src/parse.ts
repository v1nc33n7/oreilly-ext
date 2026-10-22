import { S } from "./selectors";
import { safeClick } from "./guard";
import { act } from "./fx";
import { sleep } from "./util";

export type ItemState = "watched" | "pending" | "passed" | "in_progress" | "not_started" | "unknown";
export type Kind = "video" | "knowledge_check" | "final_quiz" | "unknown";
export type Item = {
  competency: string; index: number; kind: Kind; id: string; title: string;
  label: string; ariaLabel: string; state: ItemState; seconds: number | null; path: string;
};
export type Competency = {
  id: string; title: string; status: string; items: Item[];
  badge: "claimable" | "not_earned" | "none";
};
export type Screen =
  | "overview" | "video" | "video_ended" | "quiz_interstitial"
  | "assessment" | "assessment_result" | "unsupported" | "unknown";

export const courseBase = (pathname: string): string | null => {
  const m = /^\/skill\/([^/]+)\/(\d+)\//.exec(pathname);
  return m ? `/skill/${m[1]}/${m[2]}/` : null;
};

// Non-empty text nodes outside <svg> (icon <title>s would leak in), i.e. innerText lines; jsdom has no innerText.
const lines = (el: Element): string[] => {
  const out: string[] = [];
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) { const t = (c.textContent ?? "").trim(); if (t) out.push(t); }
      else if (c.nodeName.toLowerCase() !== "svg") walk(c);
    }
  };
  walk(el);
  return out;
};

const parseSeconds = (label: string): number | null => {
  const m = /^(\d+)\s*(second|minute|hour)s?/i.exec(label);
  if (!m) return null;
  return +m[1] * { second: 1, minute: 60, hour: 3600 }[m[2].toLowerCase() as "second"];
};

function parseItem(card: Element, competency: string, index: number, base: string): Item {
  const id = card.id.replace(/^lesson-card-/, "");
  const labelEl = card.querySelector(S.statusLabel);
  const label = labelEl ? lines(labelEl)[0] ?? "" : "";
  const title = lines(card).pop() ?? "";
  const seconds = parseSeconds(label);
  const kind: Kind = id.startsWith("urn:orm:")
    ? /knowledge check/i.test(title) ? "knowledge_check" : "final_quiz"
    : /^\d+-video\d+$/.test(id) ? "video" : "unknown";
  let state: ItemState = "unknown";
  if (kind === "video") {
    state = /^(watched|completed?|done)$/i.test(label) ? "watched" : seconds !== null ? "pending" : "unknown";
  } else if (kind !== "unknown") {
    state = /^passed/i.test(label) ? "passed"
      : /continue|keep practicing|needs review/i.test(label) ? "in_progress"
      : /take the final quiz|start practicing/i.test(label) ? "not_started" : "unknown";
  }
  return { competency, index, kind, id, title, label, ariaLabel: card.getAttribute("aria-label") ?? "", state, seconds, path: base + id + "/" };
}

export function parseInventory(doc: Document, base: string): Competency[] {
  return [...doc.querySelectorAll(S.block)].map((b) => {
    const id = b.id;
    const cards = [...b.querySelectorAll(S.card)].filter((c) => c.getAttribute("role") === "button");
    return {
      id,
      title: b.querySelector(`h2[id^="competency-"]`)?.textContent?.trim() ?? "",
      status: b.querySelector(S.blockStatus)?.textContent?.trim() ?? "",
      items: cards.map((c, i) => parseItem(c, id, i + 1, base)),
      badge: b.querySelector(S.badgeClaimable) ? "claimable" : b.querySelector(S.badgePlain) ? "not_earned" : "none",
    } as Competency;
  });
}

const sig = (doc: Document) => [...doc.querySelectorAll(S.block)].map((b) => b.id).join(",");

// Cards render after the blocks do; wait until the card count holds for 2 polls.
async function settle(doc: Document): Promise<void> {
  let last = -1, same = 0;
  for (let i = 0; i < 50 && same < 2; i++) {
    const n = doc.querySelectorAll(S.block + " " + S.card).length;
    same = n === last ? same + 1 : 0;
    last = n;
    await sleep(100);
  }
}

const idKey = (id: string): [number, number] | null => {
  const m = /^(\d+)\.(\d+)$/.exec(id);
  return m ? [+m[1], +m[2]] : null;
};

export async function collectAllLevels(
  doc: Document, base: string, until?: (merged: Competency[]) => boolean,
): Promise<Competency[]> {
  let tabs = [...doc.querySelectorAll<HTMLElement>(S.levelTab)];
  if (!tabs.length) {
    const toggle = doc.querySelector<HTMLElement>(S.drawerToggle);
    if (toggle) await act(toggle, "Opening levels", "auto", () => safeClick(toggle, "open_drawer"));
    for (let i = 0; i < 30 && !tabs.length; i++) {
      await sleep(100);
      tabs = [...doc.querySelectorAll<HTMLElement>(S.levelTab)];
    }
  }
  const merged = new Map<string, Competency>();
  const add = (list: Competency[]) => list.forEach((c) => merged.has(c.id) || merged.set(c.id, c));
  if (!tabs.length) add(parseInventory(doc, base));
  for (const [n, t] of tabs.entries()) {
    if (t.getAttribute("aria-selected") !== "true") {
      const before = sig(doc);
      await act(t, "Level " + (n + 1), "auto", () => safeClick(t, "level_tab"));
      for (let i = 0; i < 30 && sig(doc) === before; i++) await sleep(100);
    }
    await settle(doc);
    add(parseInventory(doc, base));
    if (until?.([...merged.values()])) break; // shortcut: assumes tabs ascend by competency, drop `until` otherwise
  }
  return [...merged.values()].sort((a, b) => {
    const ka = idKey(a.id), kb = idKey(b.id);
    if (ka && kb) return ka[0] - kb[0] || ka[1] - kb[1];
    return ka ? -1 : kb ? 1 : 0;
  });
}

export function detectScreen(doc: Document, pathname: string): Screen {
  const base = courseBase(pathname);
  if (!base) return "unsupported";
  if (doc.querySelector(S.learnosity) || doc.querySelector(S.quizContainer))
    return doc.querySelector(S.retake) ? "assessment_result" : "assessment";
  if (doc.querySelector(S.interstitial)) return "quiz_interstitial";
  if (doc.querySelector(S.playkit)) return doc.querySelector(S.continueBtn) ? "video_ended" : "video";
  if (pathname === base && (doc.querySelector(S.block) || doc.querySelector(S.drawerToggle))) return "overview";
  return "unknown";
}

export type VideoInfo = { video: HTMLVideoElement; duration: number; currentTime: number; ended: boolean; paused: boolean };
export function readVideo(doc: Document): VideoInfo | null {
  const f = doc.querySelector<HTMLIFrameElement>(S.playkitIframe);
  const video = f?.contentDocument?.querySelector("video");
  if (!video || !Number.isFinite(video.duration)) return null;
  return { video, duration: video.duration, currentTime: video.currentTime, ended: video.ended, paused: video.paused };
}

export function listAssessmentWidgets(doc: Document): string[] {
  return [...doc.querySelectorAll(S.widget)].flatMap((w) => {
    const c = [...w.classList].find((x) => /^lrn_(?!widget$|qr$|clearfix$)/.test(x));
    return c ? [c.slice(4)] : [];
  });
}

export const MAX_VIDEO_TRIES = 2;
export const MAX_QUIZ_TRIES = 3;

// First video still to watch, or Knowledge Check / Final Quiz not yet passed, in course order.
export function nextPendingItem(
  inv: Competency[], scope: string, skipped: string[], attempts: Record<string, number>,
): Item | null {
  for (const c of inv) {
    if (scope !== "all" && c.id !== scope) continue;
    for (const it of c.items) {
      if (skipped.includes(it.id)) continue;
      const tries = attempts[it.id] ?? 0;
      if (it.kind === "video" && it.state === "pending" && tries < MAX_VIDEO_TRIES) return it;
      if ((it.kind === "knowledge_check" || it.kind === "final_quiz") && (it.state === "not_started" || it.state === "in_progress") && tries < MAX_QUIZ_TRIES) return it;
    }
  }
  return null;
}
