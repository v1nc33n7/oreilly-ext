import { initPanel } from "./panel";
import { initRunner, pause, resume, start } from "./runner";
import { S } from "./selectors";

// Runner first: it loads the saved key flag, so the panel never paints "no key" by mistake.
void (async () => {
  await initRunner();
  initPanel({
    start, pause, resume,
    scope: () => /Competency\s+([\d.]+)/.exec(document.querySelector(S.breadcrumbs)?.textContent ?? "")?.[1] ?? null,
  });
})();
