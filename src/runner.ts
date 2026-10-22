import { S } from "./selectors";
import { mirror, navigate, safeClick } from "./guard";
import { collectAllLevels, courseBase, detectScreen, listAssessmentWidgets, MAX_QUIZ_TRIES, nextPendingItem, type Competency } from "./parse";
import { playToEnd } from "./video";
import { note, render, ui, type Report } from "./panel";
import { act, thinking } from "./fx";
import { decide, questionBody, type ItemVerdict, type Page, type QSpec, type Resp, type ScreenVerdict } from "./jev";
import { activeWidget, confirmSubmit, isAnswered, pressFooter, pressResult, readPercent, readQuestion } from "./quiz";
import { sleep } from "./util";

type RunState = {
  running: boolean; scope: string; attempts: Record<string, number>;
  skipped: string[]; reasons: Record<string, string>; titles: Record<string, string>;
  watched: string[]; unknownTicks: number; startedAt: number; started: boolean;
};
const fresh = (running: boolean, scope = "all"): RunState => ({
  running, scope, attempts: {}, skipped: [], reasons: {}, titles: {}, watched: [], unknownTicks: 0, startedAt: Date.now(), started: running,
});

let st = fresh(false);
let busy = false;
// After an action that leaves the page, ticking again would re-run it on the old page (double attempts, repeat clicks).
let holdUntil = 0;
const hold = () => { holdUntil = Date.now() + 4000; };
let ctrl = new AbortController();

const save = () => { mirror.running = st.running; ui.running = st.running; ui.canResume = !st.running && st.started; return chrome.storage.local.set({ runState: st }); };

type JevReply<V> = { error?: string; cost?: number; verdict?: V };
async function ask<V>(op: "screen" | "item", payload: unknown): Promise<V | null> {
  ui.thinking = true; render();
  let r: JevReply<V>;
  try { r = await chrome.runtime.sendMessage({ type: "jev", op, payload }); }
  finally { ui.thinking = false; }
  if (r.error) { note("warn", "Jev: " + r.error); return null; }
  ui.cost += r.cost ?? 0;
  return r.verdict ?? null;
}

const visible = (e: Element) => (e as HTMLElement).offsetParent !== null;
function pagePayload(): Page {
  const txt = (e: Element) => (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 60);
  return {
    path: location.pathname.split("/").filter(Boolean).slice(-2).join("/"),
    title: document.title,
    headings: [...document.querySelectorAll("h1,h2,h3")].filter(visible).slice(0, 8).map(txt),
    buttons: [...document.querySelectorAll("button,a")].filter(visible).slice(0, 15).map(txt),
    text: document.body.innerText.slice(0, 1200),
  };
}

async function resolveUnknownItems(inv: Competency[]): Promise<string[]> {
  const { labelCache = {} } = await chrome.storage.local.get("labelCache");
  const unclassified: string[] = [];
  for (const c of inv) for (const it of c.items) {
    if (it.kind !== "unknown" && it.state !== "unknown") continue;
    const key = it.title + "|" + it.label;
    let v: ItemVerdict | null = labelCache[key] ?? null;
    if (!v) {
      v = await ask<ItemVerdict>("item", { title: it.title, id_shape: it.id.replace(/\d/g, "9"), label: it.label, aria_label: it.ariaLabel });
      if (v) labelCache[key] = v;
    }
    if (!v) unclassified.push(it.title);
    else if (v.assessment) it.kind = "final_quiz"; // never automated
    else if (v.progress === "done") it.state = "watched";
    else if (v.progress === "pending") { it.kind = "video"; it.state = "pending"; }
    else unclassified.push(it.title);
  }
  await chrome.storage.local.set({ labelCache });
  return unclassified;
}

function buildReport(inv: Competency[], unclassified: string[]): Report {
  return {
    watched: st.watched.length,
    skipped: st.skipped.map((id) => ({ title: st.titles[id] ?? id, reason: st.reasons[id] ?? "" })),
    unclassified,
    assessments: inv.flatMap((c) => c.items
      .filter((i) => (i.kind === "knowledge_check" || i.kind === "final_quiz") && i.state !== "passed")
      .map((i) => ({ competency: c.id, title: i.title, label: i.label, path: i.path }))),
    badges: inv.filter((c) => c.badge === "claimable").map((c) => c.id),
  };
}

const currentId = () => location.pathname.split("/").filter(Boolean).pop() ?? "";
const currentTitle = () => document.querySelector(S.breadcrumbs)?.textContent?.split("/").pop()?.replace(/Back to Overview/, "").trim() ?? currentId();

async function onUnknown(base: string): Promise<void> {
  st.unknownTicks++;
  if (st.unknownTicks >= 20) { st.running = false; ui.msg = "Unrecognised screen, stopped."; return; }
  if (st.unknownTicks !== 10) return;
  const v = await ask<ScreenVerdict>("screen", pagePayload());
  if (v === "loading") st.unknownTicks = 5;
  else navigate(base, "overview"); // assessment, known_safe, unknown or error: leave the page
}

let jevFails = 0;
// Quiz state lives in memory: Check Answer stays enabled after checking, so the DOM cannot tell us.
const checked = new Set<string>();
let quizIdle = 0;

async function handoff(why: string): Promise<void> {
  st.running = false;
  note("warn", `Quiz needs you: ${why}`);
  await save();
}

async function solve(spec: QSpec): Promise<number[] | null> {
  const w = activeWidget(document);
  thinking(w, true);
  let r: { error?: string; cost?: number; answers?: Resp["answers"] };
  try { r = await chrome.runtime.sendMessage({ type: "jev", op: "quiz", payload: questionBody(spec) }); }
  finally { thinking(w, false); }
  if (r.error) { note("warn", "Jev: " + r.error); return null; }
  ui.cost += r.cost ?? 0;
  return decide(spec, r.answers);
}

// One step per tick: answer + Check, or Next / Complete, or confirm the submit dialog.
async function quizStep(): Promise<void> {
  if (await confirmSubmit(document)) { quizIdle = 0; return; }
  const w = activeWidget(document);
  if (!w) { if (++quizIdle > 60) await handoff("quiz page did not load"); return; }
  quizIdle = 0;
  ui.item = currentTitle();
  if (!checked.has(w.id) && isAnswered(w)) checked.add(w.id);
  if (!checked.has(w.id)) {
    const read = readQuestion(w);
    if (!read) return handoff(`unsupported question type (${listAssessmentWidgets(document).join(", ")})`);
    const picks = await solve(read.spec);
    if (!picks) {
      // Transient provider errors: wait and retry on the next tick, up to 10 times in a row.
      if (/Jev: (http_(429|5\d\d)|network)/.test(ui.msg) && ++jevFails <= 10) { await sleep(5000); return; }
      return handoff(ui.msg.startsWith("Jev: ") ? ui.msg : "Jev answer did not match the question");
    }
    jevFails = 0;
    await read.apply(picks);
    note("jev", "Answered: " + read.spec.stem.slice(0, 50));
    // Final Quizzes have no Check Answer button (only Next / Complete); Knowledge Checks do.
    if (document.querySelector("#checkAnswerButton") && !(await pressFooter(document, "check"))) return handoff("Check Answer is not available");
    checked.add(w.id);
    return;
  }
  if (!(await pressFooter(document, "next")) && !(await pressFooter(document, "complete"))) quizIdle++;
  if (quizIdle > 30) await handoff("cannot advance");
}

async function tick(): Promise<void> {
  const base = courseBase(location.pathname);
  const screen = detectScreen(document, location.pathname);
  ui.screen = screen;
  if (screen !== "video") ui.pct = 0;
  if (!st.running || !base) return;
  if (screen !== "unknown") st.unknownTicks = 0;
  switch (screen) {
    case "overview": {
      const inv = await collectAllLevels(document, base, (m) => !!nextPendingItem(m, st.scope, [...st.skipped, ...st.watched], st.attempts));
      const unclassified = await resolveUnknownItems(inv);
      const vids = inv.flatMap((c) => c.items).filter((i) => i.kind === "video");
      ui.counts = `videos watched ${vids.filter((i) => i.state === "watched").length}/${vids.length}, pending ${Math.round(vids.reduce((s, i) => s + (i.state === "pending" ? i.seconds ?? 0 : 0), 0) / 60)} min`;
      // st.watched: played to the real end, but the overview may not have caught up yet.
      const next = nextPendingItem(inv, st.scope, [...st.skipped, ...st.watched], st.attempts);
      if (next) {
        st.attempts[next.id] = (st.attempts[next.id] ?? 0) + 1;
        st.titles[next.id] = next.title;
        await save();
        note("auto", "Opening: " + next.title);
        const kind = next.kind === "video" ? "video" : "assessment";
        const card = document.getElementById("lesson-card-" + next.id);
        if (card) await act(card, "Next: " + next.title, "auto", () => { hold(); navigate(next.path, kind); });
        else { hold(); navigate(next.path, kind); }
      } else {
        st.running = false;
        st.started = false;
        ui.report = buildReport(inv, unclassified);
        note("ok", "Done. Badges are left for you.");
        await save();
      }
      return;
    }
    case "video": {
      const id = currentId();
      ui.item = currentTitle();
      if (!ui.pct) note("auto", "Watching: " + ui.item);
      const r = await playToEnd(document, ctrl.signal, (t, d) => {
        ui.progress = `${Math.floor(t)}s / ${Math.floor(d)}s`;
        ui.pct = Math.round((100 * t) / d) || 1;
        render();
      });
      if (r.ok) {
        ui.pct = 0;
        note("ok", "Video done");
        const btn = document.querySelector(S.continueBtn);
        if (btn) await act(btn, "Continue", "auto", () => { hold(); safeClick(btn, "continue_video"); });
        if (!st.watched.includes(id)) st.watched.push(id);
      } else if (r.reason !== "aborted") {
        st.skipped.push(id);
        st.reasons[id] = r.reason;
        st.titles[id] = currentTitle();
        ui.pct = 0;
        note("warn", `Skipped ${st.titles[id]}: ${r.reason}`);
        await save();
        navigate(base, "overview");
      }
      return;
    }
    case "video_ended": {
      const btn = document.querySelector(S.continueBtn);
      if (btn) await act(btn, "Continue", "auto", () => { hold(); safeClick(btn, "continue_video"); });
      return;
    }
    case "quiz_interstitial":
      navigate(base, "overview");
      return;
    case "assessment":
      await quizStep();
      return;
    case "assessment_result": {
      const id = currentId();
      const pct = readPercent(document);
      if (pct !== null && pct < 100 && (st.attempts[id] ?? 0) < MAX_QUIZ_TRIES) {
        st.attempts[id] = (st.attempts[id] ?? 0) + 1;
        await save();
        note("auto", "Retaking quiz");
        hold();
        await pressResult(document, "retake");
      } else {
        note("ok", "Quiz finished" + (pct === null ? "" : ` (${pct}%)`));
        hold();
        await pressResult(document, "continue");
      }
      return;
    }
    case "unknown":
      await onUnknown(base);
      return;
  }
}

async function loop(): Promise<void> {
  if (busy || Date.now() < holdUntil) return;
  busy = true;
  try {
    const before = JSON.stringify(st);
    await tick();
    if (JSON.stringify(st) !== before) await save();
  }
  catch (e) { st.running = false; ui.msg = "Stopped: " + (e as Error).message; await save(); }
  finally { busy = false; render(); }
}

export function start(scope: string): void {
  ctrl = new AbortController();
  st = fresh(true, scope);
  ui.report = null; ui.msg = "";
  const base = courseBase(location.pathname);
  const s = detectScreen(document, location.pathname);
  void save().then(() => { if (base && s !== "overview" && s !== "video" && s !== "video_ended") navigate(base, "overview"); });
}
export function resume(): void { ctrl = new AbortController(); st.running = true; st.unknownTicks = 0; ui.report = null; void save(); }
export function pause(): void { st.running = false; ctrl.abort(); void save(); }

export async function initRunner(): Promise<void> {
  const { runState, openrouterApiKey } = await chrome.storage.local.get(["runState", "openrouterApiKey"]);
  if (runState) st = runState;
  ui.keySet = !!openrouterApiKey;
  mirror.running = ui.running = st.running;
  ui.canResume = !st.running && !!st.started;
  chrome.storage.onChanged.addListener((c) => {
    if (c.openrouterApiKey) { ui.keySet = !!c.openrouterApiKey.newValue; render(); }
  });
  setInterval(loop, 250);
  void loop();
}
