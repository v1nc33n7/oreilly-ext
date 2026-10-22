// Visual feedback for automated actions. Never clicks itself: callers pass the action as `run`.
import { sleep } from "./util";

export type Tone = "jev" | "auto";
export const FX = { lead: 0, tail: 100 }; // ms before / after the action
const COLOR: Record<Tone, string> = { jev: "167,139,250", auto: "34,211,238" };

const CSS = `
.oa-glow{outline:2px solid rgb(var(--oa));outline-offset:3px;animation:oa-pulse .9s ease-in-out infinite}
@keyframes oa-pulse{0%,100%{box-shadow:0 0 6px 2px rgba(var(--oa),.45)}50%{box-shadow:0 0 22px 8px rgba(var(--oa),.85)}}
.oa-done{animation:oa-flash .45s ease-out forwards}
@keyframes oa-flash{0%{box-shadow:0 0 26px 10px rgba(52,211,153,.95)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.oa-thinking{animation:oa-think 1.1s linear infinite}
@keyframes oa-think{0%,100%{box-shadow:0 0 0 2px rgba(167,139,250,.2)}50%{box-shadow:0 0 18px 4px rgba(167,139,250,.8)}}
.oa-ripple{position:fixed;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:rgba(var(--oa),.55);pointer-events:none;z-index:2147483646;animation:oa-rip .5s ease-out forwards}
@keyframes oa-rip{from{transform:scale(1);opacity:1}to{transform:scale(7);opacity:0}}
.oa-tag{position:fixed;pointer-events:none;z-index:2147483646;font:600 12px/1.2 system-ui;color:#fff;background:rgba(var(--oa),.95);padding:4px 8px;border-radius:6px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion:reduce){.oa-glow,.oa-thinking,.oa-done{animation:none}.oa-glow{box-shadow:0 0 12px 4px rgba(var(--oa),.8)}.oa-ripple{display:none}}
`;

export function ensureStyle(): void {
  if (document.getElementById("oa-fx-style")) return;
  const s = document.createElement("style");
  s.id = "oa-fx-style";
  s.textContent = CSS;
  document.head.append(s);
}

export async function act(el: Element, text: string, tone: Tone, run: () => void): Promise<void> {
  ensureStyle();
  const r = el.getBoundingClientRect();
  if (r.width === 0) { run(); return; }
  el.scrollIntoView?.({ block: "center", behavior: "instant" });
  const h = el as HTMLElement;
  h.style.setProperty("--oa", COLOR[tone]);
  h.classList.add("oa-glow");
  const tag = document.createElement("div");
  tag.className = "oa-tag";
  tag.style.setProperty("--oa", COLOR[tone]);
  tag.textContent = text;
  const top = r.top - 28;
  tag.style.top = (top < 8 ? r.bottom + 6 : top) + "px";
  tag.style.left = Math.max(8, r.left) + "px";
  document.body.append(tag);
  try {
    await sleep(FX.lead);
    const rip = document.createElement("div");
    rip.className = "oa-ripple";
    rip.style.setProperty("--oa", COLOR[tone]);
    rip.style.top = r.top + r.height / 2 + "px";
    rip.style.left = r.left + r.width / 2 + "px";
    rip.addEventListener("animationend", () => rip.remove());
    document.body.append(rip);
    run();
    h.classList.replace("oa-glow", "oa-done");
    await sleep(FX.tail);
  } finally {
    h.classList.remove("oa-glow", "oa-done");
    h.style.removeProperty("--oa");
    tag.remove();
  }
}

export function thinking(el: Element | null, on: boolean): void {
  el?.classList.toggle("oa-thinking", on);
}
