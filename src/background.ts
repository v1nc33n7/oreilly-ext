import { callJev, screenBody, itemBody, parseScreen, parseItem } from "./jev";

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "jev") return;
  (async () => {
    const { openrouterApiKey } = await chrome.storage.local.get("openrouterApiKey");
    if (!openrouterApiKey) return reply({ error: "no_key" });
    // op "quiz": payload is a ready body from questionBody (content script has no key)
    const body = msg.op === "screen" ? screenBody(msg.payload) : msg.op === "item" ? itemBody(msg.payload) : msg.payload;
    const r = await callJev(openrouterApiKey, body);
    if (!r.ok) {
      console.error("jev", msg.op, r.error, JSON.stringify(body).slice(0, 600));
      return reply({ error: r.error });
    }
    const cost = r.json?.usage?.cost ?? 0;
    if (msg.op === "quiz") return reply({ cost, answers: r.json.answers });
    reply({ cost, verdict: msg.op === "screen" ? parseScreen(r.json) : parseItem(r.json) });
  })();
  return true; // async reply
});
