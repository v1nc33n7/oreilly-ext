# O'Reilly Skills Auto-Complete — Chrome Extension

Auto-complete O'Reilly courses: auto-watch videos and auto-answer quizzes on `learning.oreilly.com` skills. AI quiz solver powered by Jev via OpenRouter.

## What it does

- ▶️ **Auto-watches O'Reilly skill videos** in real time to completion
- 🤖 **Auto-answers O'Reilly quizzes** (MCQ, dropdown, matching, token highlight via Learnosity widgets)
- 🧭 **Auto-navigates** competency blocks, lessons, and "Continue" flow
- 🛡️ **Skips assessments safely** — never touches graded items, hands off to you with a report
- 💰 **Tracks AI cost** per run (OpenRouter usage)
- ⏸️ Pause / resume anytime, per-competency or whole-course scope

## Install (load unpacked)

1. Clone this repo:
   ```bash
   git clone https://github.com/YOU/oreilly-skills-autocomplete.git
   cd oreilly-skills-autocomplete
   npm install
   npm run build
   ```
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked** → select the `dist/` folder
4. Open extension **Options**, paste your [OpenRouter API key](https://openrouter.ai/keys) → **Save**

## Use

1. Go to any O'Reilly skill, e.g. `https://learning.oreilly.com/skill/...`
2. Floating panel appears (bottom-right)
3. Click **▶ All** (whole course) or **▶ Competency X.Y** (current section only)
4. Watch it play videos and solve quizzes. **Pause** anytime; **Resume** continues.

No key? Video playback still works; quiz solving needs the key.

## How it works

| Part | File | Role |
|---|---|---|
| Runner | `src/runner.ts` | Tick loop: detect screen → play video / solve quiz / navigate |
| Quiz solver | `src/quiz.ts` + `src/jev.ts` | Reads Learnosity widget, asks `typesafe/jev-1.14` via OpenRouter decisions API |
| AI classify | `src/background.ts` | Service worker calls OpenRouter (key never touches page DOM) |
| Video | `src/video.ts` | Real-time playback, stall detection, no speed hacks |
| UI | `src/panel.ts` | Shadow-DOM floating panel, progress + cost + activity feed |

> Assessments (graded quizzes, locked items) are classified by the model and skipped, never answered.

## Dev

```bash
npm run build      # esbuild → dist/ + copy manifest.json, options.html
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

Load `dist/` as unpacked extension. Content script matches `https://learning.oreilly.com/skill/*`.

## Disclaimer

For educational purposes only. Use at your own risk; respect O'Reilly's Terms of Service.
