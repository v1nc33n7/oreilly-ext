// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { courseBase, detectScreen, listAssessmentWidgets, nextPendingItem, parseInventory, readVideo } from "../src/parse";
import { navigate, safeClick } from "../src/guard";
import { callJev, decide, parseItem, parseScreen } from "../src/jev";
import { act } from "../src/fx";
import { pressFooter, readQuestion } from "../src/quiz";

const BASE = "/skill/ai-agents/0642572295110/";
const load = (n: string) => new DOMParser().parseFromString(readFileSync(join(__dirname, "fixtures", n + ".html"), "utf8"), "text/html");

describe("parse", () => {
  const inv = parseInventory(load("overview-level4"), BASE);
  it("inventory", () => {
    expect(inv).toHaveLength(17);
    const c41 = inv[0];
    expect(c41.items).toHaveLength(5);
    expect(c41.items[1]).toMatchObject({ kind: "knowledge_check", state: "passed" });
    expect(c41.items[2]).toMatchObject({ kind: "video", state: "watched", title: "Build a Production Grade Weather Tool" });
    expect(inv[1].items[4]).toMatchObject({ kind: "final_quiz", state: "in_progress" });
    expect(inv[2].items[1]).toMatchObject({ kind: "video", state: "pending", seconds: 120, path: BASE + "0642572312275-video403133/" });
  });
  it("is course-agnostic", () => {
    const other = parseInventory(load("overview-level4"), "/skill/other-course/999/");
    expect(other[0].items.every((i) => i.path.startsWith("/skill/other-course/999/"))).toBe(true);
  });
  it("nextPendingItem", () => {
    const first = nextPendingItem(inv, "all", [], {})!;
    expect(first).toMatchObject({ competency: "4.1", kind: "final_quiz" });
    expect(nextPendingItem(inv, "all", [first.id], {})).toMatchObject({ competency: "4.2", kind: "knowledge_check" });
    expect(nextPendingItem(inv, "all", [], { [first.id]: 3 })!.competency).toBe("4.2");
    const v = nextPendingItem(inv, "4.3", [], {})!;
    expect(v.id).toBe("0642572312275-video403133");
    expect(nextPendingItem(inv, "4.3", [v.id], {})!.id).toBe("0642572312275-video403136");
    expect(nextPendingItem(inv, "4.3", [], { [v.id]: 2 })!.id).toBe("0642572312275-video403136");
    expect(nextPendingItem(inv, "4.11", [], {})).toBeNull();
  });
  it("detectScreen", () => {
    expect(detectScreen(load("video"), BASE + "x-video1/")).toBe("video");
    expect(detectScreen(load("video-ended"), BASE + "x-video1/")).toBe("video_ended");
    expect(detectScreen(load("interstitial"), BASE + "x-video1/")).toBe("quiz_interstitial");
    expect(detectScreen(load("assessment-mcq"), BASE + "urn/")).toBe("assessment");
    expect(detectScreen(load("assessment-result"), BASE + "urn/")).toBe("assessment_result");
    expect(detectScreen(load("overview-level4"), BASE)).toBe("overview");
    expect(detectScreen(load("overview-level4"), "/library/view/x/1/")).toBe("unsupported");
    expect(courseBase("/skill/a/12/rest")).toBe("/skill/a/12/");
  });
  it("assessment widgets", () => {
    expect(listAssessmentWidgets(load("assessment-mcq"))).toContain("mcq");
    expect(listAssessmentWidgets(load("assessment-final")).length).toBeGreaterThan(0);
  });
  it("readVideo needs a real <video>", () => {
    expect(readVideo(load("video"))).toBeNull();
  });
});

describe("quiz", () => {
  const widgets = [...load("assessment-final").querySelectorAll<HTMLElement>(".lrn_widget")];
  it("reads mcq, token and association widgets", () => {
    const [mcq, token, assoc] = widgets.map((w) => readQuestion(w)!.spec);
    expect(mcq).toMatchObject({ type: "mcq", multi: false });
    expect(mcq.groups[0]).toHaveLength(4);
    expect(token).toMatchObject({ type: "token", multi: false });
    expect(token.passage).toContain("⟦0: builder.add_conditional_edges");
    expect(assoc).toMatchObject({ type: "association", targets: ["Supervisor agent", "Tavily search", "Python REPL tool", "Alpha Vantage API"] });
    expect(assoc.groups[0]).toHaveLength(4);
  });
  it("decide: association never reuses an item", () => {
    const spec = readQuestion(widgets[2])!.spec;
    const p = (o: number[]) => ({ type: "choice", choice: "o" + o.indexOf(Math.max(...o)), probabilities: Object.fromEntries(o.map((x, i) => ["o" + i, x])) });
    const picks = decide(spec, { t0: p([0.9, 0.1, 0, 0]), t1: p([0.8, 0.2, 0, 0]), t2: p([0, 0, 0.6, 0.4]), t3: p([0, 0, 0.5, 0.5]) });
    expect(picks).toEqual([0, 1, 2, 3]);
  });
  it("decide: single choice takes top even at low confidence; missing answer is null", () => {
    const spec = readQuestion(widgets[0])!.spec;
    expect(decide(spec, { pick: { type: "choice", choice: "o2", confidence: 0.1 } })).toEqual([2]);
    expect(decide(spec, {})).toBeNull();
  });
  it("decide: multi-select takes noul>0.5, else the best one", () => {
    const spec = { ...readQuestion(widgets[0])!.spec, multi: true };
    const n = (x: number[]) => Object.fromEntries(x.map((v, i) => ["o" + i, { type: "noul", noul: v }]));
    expect(decide(spec, n([0.9, 0.1, 0.7, 0.2]))).toEqual([0, 2]);
    expect(decide(spec, n([0.1, 0.3, 0.2, 0.2]))).toEqual([1]);
  });
  it("pressFooter never presses skip", async () => {
    history.pushState({}, "", BASE + "urn:orm:video:1:video-clip:video2/");
    document.documentElement.innerHTML = load("assessment-mcq").documentElement.innerHTML;
    let clicked = false;
    document.querySelector("#skipButton")?.addEventListener("click", () => (clicked = true));
    await pressFooter(document, "complete");
    await pressFooter(document, "next");
    expect(clicked).toBe(false);
  });
});

describe("jev parsers", () => {
  const r = (screen: object, noul?: number) => ({ answers: { screen: { type: "choice", ...screen }, ...(noul === undefined ? {} : { is_assessment: { type: "noul", noul } }) } });
  it("parseScreen", () => {
    expect(parseScreen(r({ choice: "quiz_or_assessment", confidence: 1 }, 0.9))).toBe("assessment");
    expect(parseScreen(r({ choice: "video_playing", confidence: 0.9 }, 0.25))).toBe("assessment");
    expect(parseScreen(r({ choice: "video_playing", confidence: 0.4 }, 0.01))).toBe("unknown");
    expect(parseScreen(r({ choice: "loading", confidence: 0.8 }, 0.01))).toBe("loading");
    expect(parseScreen(r({ choice: "loading", confidence: 0.8 }))).toBe("unknown");
  });
  it("parseItem fails closed", () => {
    expect(parseItem(undefined)).toEqual({ assessment: true, progress: "other" });
  });
});

describe("guard", () => {
  const mk = (html: string) => { document.body.innerHTML = html; return document.body.firstElementChild!; };
  it("blocks quiz and badge targets", () => {
    for (const h of [
      '<button data-testid="retake-button"></button>', "<button>Start final quiz</button>",
      '<button class="lrn_validate"></button>', '<input type="radio">',
      '<button data-testid="badge-card-button-container"></button>',
    ]) expect(() => safeClick(mk(h), "continue_video")).toThrow("blocked click");
  });
  it("blocks quiz navigation", () => {
    history.pushState({}, "", BASE);
    expect(() => navigate(BASE + "urn:orm:video:1:video-clip:video2/", "video")).toThrow("blocked navigation");
    expect(() => navigate("/skill/other/1/", "overview")).toThrow("blocked navigation");
  });
});

describe("source hygiene", () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
  const src = files(join(__dirname, "../src"));
  it("only guard.ts and quiz.ts act on the page", () => {
    for (const f of src.filter((f) => !/(guard|quiz)\.ts$/.test(f)))
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\.click\(|\.dispatchEvent\(|location\.assign\(|location\.href\s*=|\.submit\(/);
  });
  it("no hardcoded course", () => {
    for (const f of src) expect(readFileSync(f, "utf8"), f).not.toMatch(/ai-agents|0642572295110/);
  });
});

describe("jev errors and fx", () => {
  it("callJev surfaces the OpenRouter error message", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: 400, message: "Invalid request parameters" } }), { status: 400 }));
    expect(await callJev("k", {})).toEqual({ ok: false, error: "http_400 (Invalid request parameters)" });
    vi.unstubAllGlobals();
  });
  const mk = () => {
    const el = document.createElement("div");
    document.body.append(el);
    el.getBoundingClientRect = () => ({ width: 10, height: 10, top: 50, left: 50, bottom: 60, right: 60 }) as DOMRect;
    return el;
  };
  const clean = (el: Element) => {
    expect(el.classList.contains("oa-glow") || el.classList.contains("oa-done")).toBe(false);
    expect(document.querySelector(".oa-tag")).toBeNull();
  };
  it("act runs the action once and always cleans up", async () => {
    const el = mk(), fn = vi.fn();
    await act(el, "x", "auto", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    clean(el);
    const bad = mk();
    await expect(act(bad, "x", "jev", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    clean(bad);
  });
});
