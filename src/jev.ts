import { sleep } from "./util";

export const MODEL = "typesafe/jev-1.14";
const URL = "https://openrouter.ai/api/alpha/decisions";

export type Page = { path: string; title: string; headings: string[]; buttons: string[]; text: string };
export type ItemInfo = { title: string; id_shape: string; label: string; aria_label: string };
type Answer = { type?: string; choice?: string; confidence?: number; noul?: number; probabilities?: Record<string, number> };
export type Resp = { answers?: Record<string, Answer | undefined>; usage?: { cost?: number } };
export type JevResult = { ok: true; json: Resp } | { ok: false; error: string };

export const screenBody = (page: Page) => ({
  model: MODEL,
  state: { page },
  questions: {
    screen: {
      type: "choice",
      instructions: "Which kind of screen does `page` show?",
      criteria: {
        quiz_or_assessment: "Quiz questions with answer options, or a screen to start, check, submit or review a quiz",
        loading: "Mostly empty or only a spinner, loading text or navigation bars",
        video_playing: "A video player with play controls and no quiz questions",
        video_finished: "A video player with a Continue button after the video ended",
        course_overview: "A list of competencies, lessons and progress statuses",
        other: "Anything else, such as a login page, an error page or a settings page",
      },
    },
    is_assessment: {
      type: "noul",
      instructions: "Does `page` show quiz questions with answer options, or a screen to start, check, submit or review a quiz?",
    },
  },
});

export const itemBody = (item: ItemInfo) => ({
  model: MODEL,
  state: { item },
  questions: {
    is_assessment: { type: "noul", instructions: "Is `item` a quiz, test, check or exam, rather than a video or reading?" },
    progress: {
      type: "choice",
      instructions: "What does `item.label` say about the learner's progress on this item?",
      criteria: {
        pending: "The item is not finished yet: it shows a duration to watch, a start or continue prompt",
        done: "The item is finished: it says watched, completed, done or passed",
        locked: "The item is locked or unavailable",
        other: "None of the above",
      },
    },
  },
});

export type ScreenVerdict = "assessment" | "loading" | "known_safe" | "unknown";

// Thresholds are asymmetric: a false "not assessment" is the costly error.
export function parseScreen(json: Resp | undefined): ScreenVerdict {
  const s = json?.answers?.screen, a = json?.answers?.is_assessment;
  if (s?.type !== "choice" || a?.type !== "noul" || typeof a.noul !== "number") return "unknown";
  if (a.noul > 0.2 || s.choice === "quiz_or_assessment") return "assessment";
  if ((s.confidence ?? 0) >= 0.6) {
    if (s.choice === "loading") return "loading";
    if (["video_playing", "video_finished", "course_overview"].includes(s.choice ?? "")) return "known_safe";
  }
  return "unknown";
}

export type ItemVerdict = { assessment: boolean; progress: "pending" | "done" | "locked" | "other" };

export function parseItem(json: Resp | undefined): ItemVerdict {
  const p = json?.answers?.progress, a = json?.answers?.is_assessment;
  if (p?.type !== "choice" || a?.type !== "noul" || typeof a.noul !== "number") return { assessment: true, progress: "other" };
  const ok = (p.confidence ?? 0) >= 0.6 && ["pending", "done", "locked"].includes(p.choice ?? "");
  return { assessment: a.noul > 0.2, progress: ok ? (p.choice as ItemVerdict["progress"]) : "other" };
}

const RETRY = [429, 500, 502, 503, 524, 529];

export async function callJev(key: string, body: unknown): Promise<JevResult> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(URL, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, error: "network" };
    }
    if (RETRY.includes(res.status) && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
    if (res.status === 402) return { ok: false, error: "openrouter_credits" };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "bad_key" };
    if (res.status !== 200) {
      const raw = await res.text().catch(() => "");
      let msg = "";
      try { msg = JSON.parse(raw)?.error?.message ?? ""; } catch { /* non-JSON body */ }
      return { ok: false, error: "http_" + res.status + (msg ? ` (${String(msg).slice(0, 120)})` : "") };
    }
    try { return { ok: true, json: await res.json() }; } catch { return { ok: false, error: "http_200" }; }
  }
}

// One quiz question, DOM-free. Option indexes are what `decide` returns.
// mcq/token: groups=[options]; cloze: one group per blank; association: groups=[items] + targets.
export type QSpec = {
  type: "mcq" | "cloze" | "association" | "token";
  multi: boolean; stem: string; passage: string; groups: string[][]; targets: string[];
};

const crit = (opts: string[]) => Object.fromEntries(opts.map((t, i) => ["o" + i, t]));
const pick = (instructions: string, opts: string[]) => ({ type: "choice", instructions, criteria: crit(opts) });

export function questionBody(q: QSpec) {
  const model = MODEL;
  const single = !q.multi && (q.type === "mcq" || q.type === "token");
  if (single) {
    const what = q.type === "mcq" ? "Which option is the correct answer to `question`?" : "Which token of `passage` correctly answers `question`?";
    return { model, state: { question: q.stem, passage: q.passage }, questions: { pick: pick(what, q.groups[0]) } };
  }
  if (q.type === "mcq" || q.type === "token") {
    const state = { question: q.stem, passage: q.passage, options: crit(q.groups[0]) };
    const questions = Object.fromEntries(q.groups[0].map((_, i) => ["o" + i, {
      type: "noul", instructions: `Is \`options.o${i}\` a correct answer to \`question\`?`,
    }]));
    return { model, state, questions };
  }
  if (q.type === "cloze") {
    const questions = Object.fromEntries(q.groups.map((g, i) => ["b" + i, pick(`Which option correctly fills [BLANK ${i + 1}] in \`passage\`?`, g)]));
    return { model, state: { instruction: q.stem, passage: q.passage }, questions };
  }
  const state = { instruction: q.stem, targets: Object.fromEntries(q.targets.map((t, i) => ["t" + i, t])) };
  const questions = Object.fromEntries(q.targets.map((_, i) => ["t" + i, pick(`Which item matches \`targets.t${i}\` best?`, q.groups[0])]));
  return { model, state, questions };
}

const idx = (a?: Answer): number | null => {
  const m = a?.type === "choice" ? /^o(\d+)$/.exec(a.choice ?? "") : null;
  return m ? +m[1] : null;
};

// Low confidence is deliberately ignored: the top option is always taken.
// Returns null if the response lacks any needed answer (caller hands off to the learner).
export function decide(q: QSpec, answers: Resp["answers"]): number[] | null {
  if (!answers) return null;
  if ((q.type === "mcq" || q.type === "token") && !q.multi) {
    const i = idx(answers.pick);
    return i === null ? null : [i];
  }
  if (q.type === "mcq" || q.type === "token") {
    const p = q.groups[0].map((_, i) => answers["o" + i]?.noul);
    if (p.some((x) => typeof x !== "number")) return null;
    const chosen = p.flatMap((x, i) => ((x as number) > 0.5 ? [i] : []));
    return chosen.length ? chosen : [p.indexOf(Math.max(...(p as number[])))];
  }
  if (q.type === "cloze") {
    const r = q.groups.map((_, i) => idx(answers["b" + i]));
    return r.every((x) => x !== null) ? (r as number[]) : null;
  }
  // association: each item at most once, best probabilities first
  const cand: [number, number, number][] = [];
  q.targets.forEach((_, t) => {
    const pr = answers["t" + t]?.probabilities ?? {};
    q.groups[0].forEach((_, j) => cand.push([t, j, pr["o" + j] ?? 0]));
  });
  cand.sort((a, b) => b[2] - a[2]);
  const out: (number | null)[] = q.targets.map(() => null);
  const used = new Set<number>();
  for (const [t, j] of cand) if (out[t] === null && !used.has(j)) { out[t] = j; used.add(j); }
  q.targets.forEach((_, t) => { if (out[t] === null) out[t] = idx(answers["t" + t]); });
  return out.every((x) => x !== null) ? (out as number[]) : null;
}
