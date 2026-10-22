import { navigate } from "./guard";
import { ensureStyle } from "./fx";

export type Report = {
  watched: number;
  skipped: { title: string; reason: string }[];
  unclassified: string[];
  assessments: { competency: string; title: string; label: string; path: string }[];
  badges: string[];
};

type Kind = "auto" | "jev" | "warn" | "ok";
type Entry = { kind: Kind; text: string };

export const ui = {
  screen: "", item: "", progress: "", msg: "", cost: 0, keySet: false, counts: "",
  running: false, canResume: false, report: null as Report | null,
  thinking: false, pct: 0, log: [] as Entry[],
};

// Activity feed: newest first, also mirrored into ui.msg.
export function note(kind: Kind, text: string): void {
  ui.log.unshift({ kind, text });
  ui.log.length = Math.min(ui.log.length, 6);
  ui.msg = text;
}

export type Handlers = { start(scope: string): void; pause(): void; resume(): void; scope(): string | null };

const CSS = `
:host{all:initial}
.card{background:rgba(15,23,42,.92);color:#e2e8f0;font:12px/1.4 system-ui,sans-serif;border-radius:12px;width:320px;max-height:70vh;overflow:auto;padding:10px;box-sizing:border-box;backdrop-filter:blur(8px);box-shadow:0 8px 30px rgba(0,0,0,.4)}
.hdr{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.title{font:600 13px/1.2 ui-rounded,"SF Pro Rounded",system-ui,sans-serif;letter-spacing:.02em;flex:1}
.dot{width:10px;height:10px;border-radius:50%;background:#64748b}
.dot.running{background:#34d399}
.dot.thinking{background:#a78bfa}
.dot.error{background:#f87171}
.badge{font-size:11px;padding:2px 8px;border-radius:99px;background:#78350f;color:#fde68a}
.badge.ok{background:#064e3b;color:#a7f3d0}
.bar{height:6px;border-radius:3px;background:#1e293b;margin:6px 0;overflow:hidden}
.fill{height:100%;width:0;background:linear-gradient(90deg,#a78bfa,#22d3ee);transition:width .25s linear}
.line{margin:2px 0;word-break:break-word}
.muted{color:#94a3b8}
.feed .row{display:flex;gap:6px;align-items:baseline;margin:2px 0}
.feed .row::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--c)}
.feed .row.auto{--c:#22d3ee}.feed .row.jev{--c:#a78bfa}.feed .row.ok{--c:#34d399}.feed .row.warn{--c:#fbbf24}
.feed .row.new{animation:slide .3s ease-out}
@keyframes slide{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
.btns .wide{grid-column:1/-1}
.sep{border-top:1px solid #1e293b;margin:8px 0}
button{font:inherit;color:#e2e8f0;background:#334155;border:0;border-radius:6px;padding:6px 10px;cursor:pointer}
button:hover:not(:disabled){background:#475569}
button.primary{background:#0e7490}
button.primary:hover:not(:disabled){background:#0891b2}
button:disabled{opacity:.4;cursor:default}
button.link{background:none;padding:0;color:#94a3b8;text-decoration:underline}
input{width:180px;font:inherit;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;padding:3px 6px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

let root: ShadowRoot | null = null;
let handlers: Handlers;
let host: HTMLElement;
let n: Record<"dot" | "badge" | "status" | "msg" | "change" | "keyRow" | "bar" | "fill" | "item" | "counts" | "cost" | "feed" | "btns" | "report", HTMLElement>;
let b: Record<"all" | "scope" | "pause" | "resume", HTMLButtonElement>;
let lastLog: Entry | undefined, lastLen = -1, lastReport: Report | null | undefined, lastRunning: boolean | undefined;
let keyOpen = false;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: ParentNode, text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.append(e);
  return e;
};
const mkBtn = (label: string, fn: () => void, cls = "", parent?: Element) => {
  const x = el("button", cls, parent, label);
  x.onclick = fn;
  return x;
};
const line = (parent: Element, t: string) => el("div", "line", parent, t);

export function initPanel(h: Handlers): void {
  if (root) return;
  handlers = h;
  ensureStyle();
  host = document.createElement("div");
  host.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:2147483647";
  root = host.attachShadow({ mode: "open" });
  const style = el("style", "", root);
  style.textContent = CSS;
  const card = el("div", "card", root);
  const hdr = el("div", "hdr", card);
  const dot = el("span", "dot", hdr);
  el("span", "title", hdr, "Jev");
  const badge = el("span", "badge", hdr);
  const status = el("div", "line muted", card);
  const msg = el("div", "line", card);

  // Built once so typing in the key box survives re-renders.
  const keyRow = el("div", "line", card);
  const input = el("input", "", keyRow);
  input.type = "password";
  input.placeholder = "OpenRouter API key";
  input.autocomplete = "off";
  mkBtn("Save key", async () => {
    const key = input.value.trim();
    if (!key) { ui.msg = "Empty key not saved"; render(); return; }
    await chrome.storage.local.set({ openrouterApiKey: key });
    input.value = "";
    ui.keySet = true;
    keyOpen = false;
    ui.msg = "Key saved";
    render();
  }, "", keyRow);
  const change = mkBtn("change key", () => { keyOpen = !keyOpen; render(); }, "link", card);

  const btns = el("div", "btns", card);
  b = {
    all: mkBtn("Run Course", () => handlers.start("all"), "primary wide", btns),
    scope: mkBtn("Run Current Chapter", () => { const s = handlers.scope(); if (s) handlers.start(s); }, "wide", btns),
    pause: mkBtn("Hold", () => handlers.pause(), "", btns),
    resume: mkBtn("Carry on", () => handlers.resume(), "", btns),
  };
  el("div", "sep", card);
  const bar = el("div", "bar", card);
  const fill = el("div", "fill", bar);
  const item = line(card, "");
  const counts = line(card, "");
  const cost = el("div", "line muted", card);
  const feed = el("div", "feed", card);
  const report = el("div", "", card);
  n = { dot, badge, status, msg, change, keyRow, bar, fill, item, counts, cost, feed, btns, report };
  document.documentElement.append(host);
  render();
}

export function render(): void {
  if (!root) return;
  n.dot.className = "dot" + (ui.thinking ? " thinking" : ui.running ? " running" : /^(Stopped|Quiz needs)/.test(ui.msg) ? " error" : "");
  n.badge.textContent = ui.keySet ? "Jev ready" : "Add OpenRouter key";
  n.badge.className = "badge" + (ui.keySet ? " ok" : "");
  n.status.textContent = `${ui.running ? "RUNNING" : "idle"} · screen: ${ui.screen}`;
  n.keyRow.hidden = ui.keySet && !keyOpen;
  n.change.hidden = !ui.keySet;
  n.bar.hidden = !ui.pct;
  n.fill.style.width = ui.pct + "%";
  n.item.textContent = ui.item + (ui.progress ? " " + ui.progress : "");
  n.counts.textContent = ui.counts;
  n.cost.textContent = ui.cost ? `Jev cost: $${ui.cost.toFixed(5)}` : "";
  n.msg.textContent = ui.msg === ui.log[0]?.text ? "" : ui.msg; // messages set outside note()
  if (ui.log[0] !== lastLog || ui.log.length !== lastLen) {
    n.feed.replaceChildren();
    ui.log.forEach((e, i) => el("div", `row ${e.kind}${i === 0 ? " new" : ""}`, n.feed, e.text));
    lastLog = ui.log[0]; lastLen = ui.log.length;
  }
  b.all.disabled = b.scope.disabled = ui.running;
  b.scope.hidden = !handlers.scope();
  b.pause.disabled = !ui.running;
  b.resume.disabled = !ui.canResume;
  if (ui.report !== lastReport || ui.running !== lastRunning) {
    lastReport = ui.report; lastRunning = ui.running;
    renderReport();
  }
}

function renderReport(): void {
  n.report.replaceChildren();
  const r = ui.report;
  if (!r || ui.running) return;
  const box = n.report;
  line(box, `Videos watched: ${r.watched}`);
  if (r.skipped.length) line(box, "Skipped: " + r.skipped.map((s) => `${s.title} (${s.reason})`).join("; "));
  if (r.unclassified.length) line(box, "Could not classify: " + r.unclassified.join("; "));
  if (r.assessments.length) {
    line(box, "Assessments waiting for you:");
    for (const a of r.assessments) {
      const d = line(box, `Competency ${a.competency} — ${a.title} — ${a.label} `);
      mkBtn("Open", () => navigate(a.path, "learner_open"), "", d);
    }
  }
  if (r.badges.length) {
    line(box, "Badges ready to claim:");
    for (const id of r.badges) {
      const d = line(box, `Competency ${id} `);
      mkBtn("Show", () => {
        const t = document.getElementById(id);
        t?.scrollIntoView({ block: "center" });
        if (t) {
          t.style.setProperty("--oa", "34,211,238");
          t.classList.add("oa-glow");
          setTimeout(() => { t.classList.remove("oa-glow"); t.style.removeProperty("--oa"); }, 3000);
        }
      }, "", d);
    }
  }
}
