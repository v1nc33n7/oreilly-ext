// The only module that clicks or navigates. Never add quiz/badge targets here.
import { S } from "./selectors";
import { courseBase, detectScreen } from "./parse";

export const mirror = { running: false };

// Quiz pages can register a beforeunload handler that raises Chrome's "Leave site?" dialog and stalls the run.
// Our own navigations are deliberate, so for a few seconds after one we stop the page's handlers from seeing the event.
let muteUntil = 0;
export const allowUnload = (ms = 5000): void => { muteUntil = Date.now() + ms; };
window.addEventListener("beforeunload", (e) => { if (Date.now() < muteUntil) e.stopImmediatePropagation(); }, true);

export type ClickWhy = "continue_video" | "open_drawer" | "level_tab";

export function safeClick(el: Element, why: ClickWhy): void {
  const ok =
    (why === "continue_video" && el.matches(S.continueBtn) && detectScreen(document, location.pathname) === "video_ended") ||
    (why === "open_drawer" && el.matches(S.drawerToggle)) ||
    (why === "level_tab" && el.matches(S.levelTab));
  if (!ok) throw new Error("blocked click");
  if (why === "continue_video") allowUnload();
  (el as HTMLElement).click();
}

export type NavWhy = "overview" | "video" | "assessment" | "learner_open";

export function navigate(path: string, why: NavWhy): void {
  const base = courseBase(location.pathname);
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const ok =
    !!base &&
    ((why === "overview" && path === base) ||
      (why === "video" && path.startsWith(base) && /^\d+-video\d+$/.test(last)) ||
      (why === "assessment" && path.startsWith(base) && last.startsWith("urn:orm:video:")) ||
      (why === "learner_open" && path.startsWith(base) && !mirror.running));
  if (!ok) throw new Error("blocked navigation");
  if (why !== "learner_open") allowUnload();
  location.assign(path);
}
