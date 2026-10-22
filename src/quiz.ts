// Quiz reading and answering (Learnosity widgets). With guard.ts, one of the two modules allowed to act on the page.
import { S } from "./selectors";
import { detectScreen } from "./parse";
import type { QSpec } from "./jev";
import { act } from "./fx";

export type Read = { spec: QSpec; apply(picks: number[]): Promise<void> };

const text = (e: Element | null | undefined) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();

// The widget currently shown: the others are stacked with visibility:hidden.
export function activeWidget(doc: Document): HTMLElement | null {
  return [...doc.querySelectorAll<HTMLElement>(S.widget)].find((w) => getComputedStyle(w).visibility === "visible") ?? null;
}

const tokenText = (t: Element) => text(t.firstElementChild ?? t);

export function readQuestion(w: HTMLElement): Read | null {
  const stem = text(w.querySelector(".lrn_stimulus"));
  const base = { multi: false, stem, passage: "", groups: [] as string[][], targets: [] as string[] };

  if (w.classList.contains("lrn_mcq")) {
    const inputs = [...w.querySelectorAll<HTMLInputElement>(".lrn-mcq-option input")];
    const opts = [...w.querySelectorAll(".lrn-mcq-option")].map((o) => text(o.querySelector(".lrn_contentWrapper") ?? o));
    if (!inputs.length || inputs.length !== opts.length) return null;
    return {
      spec: { ...base, type: "mcq", multi: inputs[0].type === "checkbox", groups: [opts] },
      async apply(picks) {
        for (const i of picks) {
          if (inputs[i].checked) continue;
          await act(inputs[i].closest(".lrn-mcq-option") ?? inputs[i], "Jev → " + opts[i].slice(0, 40), "jev", () => inputs[i].click());
        }
      },
    };
  }

  if (w.classList.contains("lrn_clozedropdown")) {
    const selects = [...w.querySelectorAll<HTMLSelectElement>("select.lrn_cloze_response")];
    if (!selects.length) return null;
    const body = w.querySelector(".lrn_response_input")!.cloneNode(true) as Element;
    body.querySelectorAll(".lrn_combobox").forEach((c, i) => c.replaceWith(`[BLANK ${i + 1}]`));
    const options = selects.map((s) => [...s.options].filter((o) => o.value !== ""));
    return {
      spec: { ...base, type: "cloze", passage: text(body), groups: options.map((o) => o.map((x) => text(x))) },
      async apply(picks) {
        for (const [i, p] of picks.entries()) {
          await act(selects[i], "Jev → " + text(options[i][p]), "jev", () => {
            selects[i].value = options[i][p].value;
            selects[i].dispatchEvent(new Event("change", { bubbles: true }));
          });
        }
      },
    };
  }

  if (w.classList.contains("lrn_association")) {
    const items = [...w.querySelectorAll(".lrn_possibilityList .lrn_item")].map(text);
    const targets = [...w.querySelectorAll(".lrn_assoc_question")].map(text);
    const zones = [...w.querySelectorAll<HTMLElement>(".lrn_dropzone")];
    if (!items.length || targets.length !== zones.length) return null;
    return {
      spec: { ...base, type: "association", groups: [items], targets },
      async apply(picks) {
        // The pool shrinks on each drop, so re-find the item by text every time.
        for (let t = 0; t < picks.length; t++) {
          const el = [...w.querySelectorAll<HTMLElement>(".lrn_possibilityList .lrn_btn_drag")].find((e) => text(e.querySelector(".lrn_item")) === items[picks[t]]);
          if (!el) continue;
          await act(el, "Jev → " + items[picks[t]].slice(0, 40), "jev", () => el.click());
          await act(zones[t], "→ " + targets[t].slice(0, 40), "jev", () => zones[t].click());
        }
      },
    };
  }

  if (w.classList.contains("lrn_tokenhighlight")) {
    const tokens = [...w.querySelectorAll<HTMLElement>(".lrn_token")];
    if (!tokens.length) return null;
    const body = w.querySelector(".lrn_tokenhighlight_text")!;
    const prompt = text(body.querySelector("p"));
    const copy = body.cloneNode(true) as Element;
    copy.querySelectorAll(".lrn_token").forEach((t, i) => t.replaceWith(`⟦${i}: ${tokenText(t)}⟧`));
    return {
      spec: {
        ...base, type: "token", stem: (stem + " " + prompt).trim(), passage: text(copy),
        multi: /\b(all|every|each|two|three|four|multiple|both)\b/i.test(prompt || stem),
        groups: [tokens.map(tokenText)],
      },
      async apply(picks) {
        for (const i of picks) await act(tokens[i], "Jev → " + tokenText(tokens[i]).slice(0, 40), "jev", () => tokens[i].click());
      },
    };
  }
  return null;
}

type Footer = "check" | "next" | "complete";
const footerFind = (doc: Document, which: Footer): HTMLButtonElement | null =>
  which === "check"
    ? doc.querySelector<HTMLButtonElement>("#checkAnswerButton")
    : [...doc.querySelectorAll<HTMLButtonElement>(S.footerButtons)].find((b) => text(b) === (which === "next" ? "Next question" : "Complete quiz")) ?? null;

// Only these footer buttons are ever pressed; "I'm not sure" (#skipButton) and Report are not reachable.
export async function pressFooter(doc: Document, which: Footer): Promise<boolean> {
  const b = footerFind(doc, which);
  if (!b || b.disabled || detectScreen(doc, location.pathname) !== "assessment") return false;
  await act(b, { check: "Check Answer", next: "Next question", complete: "Complete quiz" }[which], "auto", () => b.click());
  return true;
}

// The "Quiz complete … ready to submit?" dialog that follows Complete quiz.
export async function confirmSubmit(doc: Document): Promise<boolean> {
  const d = [...doc.querySelectorAll('[role="dialog"]')].find((x) => /ready to submit/i.test(x.textContent ?? ""));
  const yes = d && [...d.querySelectorAll("button")].find((b) => text(b) === "Yes");
  if (!yes) return false;
  await act(yes, "Confirm submit", "auto", () => yes.click());
  return true;
}

export const readPercent = (doc: Document): number | null => {
  const m = /You got (\d+)% correct/.exec(doc.querySelector(S.quizContainer)?.textContent ?? "");
  return m ? +m[1] : null;
};

export async function pressResult(doc: Document, which: "continue" | "retake"): Promise<boolean> {
  if (detectScreen(doc, location.pathname) !== "assessment_result") return false;
  const sel = which === "retake" ? S.retake : S.continueBtn;
  const b = [...doc.querySelectorAll<HTMLElement>(sel)].find((x) => text(x) !== "");
  if (!b) return false;
  await act(b, which === "retake" ? "Retake" : "Continue", "auto", () => b.click());
  return true;
}

// A widget the learner (or an earlier run) already filled in: leave it and move on.
export function isAnswered(w: HTMLElement): boolean {
  if (w.classList.contains("lrn_mcq")) return [...w.querySelectorAll<HTMLInputElement>(".lrn-mcq-option input")].some((i) => i.checked);
  if (w.classList.contains("lrn_clozedropdown")) return [...w.querySelectorAll<HTMLSelectElement>("select.lrn_cloze_response")].every((s) => s.value !== "");
  if (w.classList.contains("lrn_association"))
    return w.querySelectorAll(".lrn_dropzone").length > 0 && w.querySelectorAll(".lrn_possibilityList .lrn_btn_drag").length === 0;
  return false;
}
