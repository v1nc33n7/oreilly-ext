// The only module that clicks or navigates. Never add quiz/badge targets here.
import { S } from "./selectors";
import { courseBase, detectScreen } from "./parse";

export const mirror = { running: false };

export type ClickWhy = "continue_video" | "open_drawer" | "level_tab";

export function safeClick(el: Element, why: ClickWhy): void {
  const ok =
    (why === "continue_video" && el.matches(S.continueBtn) && detectScreen(document, location.pathname) === "video_ended") ||
    (why === "open_drawer" && el.matches(S.drawerToggle)) ||
    (why === "level_tab" && el.matches(S.levelTab));
  if (!ok) throw new Error("blocked click");
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
  location.assign(path);
}
