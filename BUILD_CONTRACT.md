# Rallenta Phase 1 MVP — Build Contract

Name: **RALLENTA** (locked). Tagline: "Your rest. Your readings. Your device."
Spec: `~/workspace/your_files/sleep-vitals-app-spec/sleep-vitals-app-spec.pdf` (written as "NightMetric" — build as Rallenta).
Build dir: `~/workspace/rallenta/`. Stack: single-file-ish vanilla HTML/CSS/JS PWA, mobile-first, one-handed.
Styling: dark, premium, futuristic, **electric-blue accents** (not navy/gold). Background ~#0b0e1a, surfaces ~#141a2e, accent #2f7bff / #38e1ff.
Chart colors: neutral blue #5b9dff and violet #a78bfa. **NEVER red/green health grading, never "healthy/unhealthy/normal/abnormal".**

## Module ownership (no cross-writing files)
- **UI worker**: `index.html`, `styles.css`, `app.js`, `player.js`, `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`
- **Data worker**: `data.js`, `charts.js`, `logic.js`
- **Audio worker**: `audio/rain-bed-rallenta-v1.mp3`, `audio/ambient-pad-rallenta-v1.mp3`, `audio/manifest.json`

## data.js API (exact names)
```js
RallentaDB.init() -> Promise<void>                      // opens IDB 'rallenta-db', version 1, runs migrations
RallentaDB.saveVital({metric_type, value_primary, value_secondary?, unit, measured_at, context?, note?}) -> Promise<entry>
RallentaDB.saveSleep({bed_at, wake_at, latency_minutes?, awake_minutes?, quality, tags?, note?}) -> Promise<entry> // computes derived_duration_min
RallentaDB.updateEntry(id, patch) -> Promise<entry>
RallentaDB.deleteEntry(id) -> Promise<void>
RallentaDB.deleteCategory(kind) -> Promise<number>      // kind: 'sleep' | 'vital' | metric_type e.g. 'blood_pressure'
RallentaDB.deleteAll() -> Promise<void>                 // wipes entries + prefs (confirmed destructive)
RallentaDB.listEntries({kind, metric_type?, since?, limit?}) -> Promise<entry[]>  // newest first
RallentaDB.exportJSON() -> Promise<object>              // {app:'rallenta', schema_version, exported_at, disclaimer, preferences, entries}
RallentaDB.importJSON(obj, {mode:'preview'}) -> Promise<{counts:{sleep,vitals}, conflicts:number, ok:boolean, errors:[]}>
RallentaDB.importJSON(obj, {mode:'commit', onConflict:'skip'|'replace'|'duplicate'}) -> Promise<{imported:number, skipped:number}>
RallentaDB.exportCSV() -> Promise<string>
RallentaDB.getPrefs() -> Promise<prefs>  /  RallentaDB.setPrefs(patch) -> Promise<prefs>
```
- Stores: `entries` (keyPath id), `prefs` (keyPath key). schema_version: 1 on every entry.
- IDs: `crypto.randomUUID()`. Timestamps: ISO 8601 with local offset (e.g. `2026-09-27T22:15:00-05:00`).
- metric_type enum: `blood_pressure|heart_rate|blood_sugar|weight|bmi`. unit enum: `mmHg|bpm|mg/dL|mmol/L|lb|kg|kg/m²`.
- Blood pressure: value_primary=systolic, value_secondary=diastolic. entry_source always `'manual'`.
- Prefs defaults: `{timeFormat: localeDefault('12h'|'24h'), weightUnit:'lb'|'kg' (locale), glucoseUnit:'mg/dL'|'mmol/L' (locale), heightCm:null, sleepTargetMin:480, disclaimerAcceptedAt:null, onboardingDone:false, entitlement:'free'}`.

## logic.js API
```js
RallentaLogic.plausible(metric_type, values, unit) -> {ok:boolean, message?:string}
// bounds (mechanical only): BP sys 70–300, dia 30–200, sys>dia; HR 25–250; glucose mg/dL 20–600 / mmol/L 1.1–33.3; weight lb 50–1500 / kg 22–680; bmi 10–100; sleep 0–24h span
RallentaLogic.convert(value, fromUnit, toUnit) // glucose ÷18, weight ÷2.20462; never silent — UI must show both
RallentaLogic.deriveSleep(entry) -> {inBedMin, asleepMin, assumptions:[strings]} // asleep = wake-bed-latency-awake, floor 0
RallentaLogic.targetGap(asleepMin, targetMin) -> max(0, target-asleep)
RallentaLogic.sleepDebt(sleepEntries, targetMin, days) -> {totalGapMin, days:[{date, gapMin|null}]}
RallentaLogic.describeStats(values) -> {n, avg, median, min, max}
```

## charts.js API
```js
RallentaCharts.render(el, {points:[{t:ms,label,value}], unit, color}) // SVG; gaps = breaks (no interpolation); min 2 points or empty-state; axes show units
RallentaCharts.table(el, {points, unit}) // screen-reader/export table alternative
```

## Screens (UI worker, hash routes)
`#/welcome` (one-sentence promise, local-first explainer, disclaimer + timestamped accept checkbox), `#/setup` (time format, weight/glucose units, optional height, sleep target slider, logging-card prefs), `#/today` (last sleep summary, target gap, recent entries, quick-log grid, wind-down shortcut, "Saved on this device" status; honest empty state), `#/log` (chooser; tiles say "Enter a reading"; last-used first), `#/log/sleep`, `#/log/vital/<type>`, `#/trends` (7/30/90d, metric selector, avg/median/count, sleep duration+quality views, debt summary), `#/audio` (2 tracks, player), `#/settings` (units, target, reminders, export/import/delete, About+disclaimer), `#/about`.
- Every vital entry screen shows label: **"Manual entry — not measured by this phone."** Large numeric fields. Review step before save. Undo toast (8s) after save/delete.
- Free tier: `VISIBLE_DAYS = 14` for Today/Trends lists (entitlement 'free', no paywall in Phase 1). Data retained; JSON backup always free.
- Reminders: local only; Notification permission requested on first reminder save; copy "Time for your Rallenta check-in"; on launch, check due/missed and notify; in-app timers while open.
- GA4: `G-DJXTN8EDT4`, page_view + app_launch only. **No health values, notes, timestamps, or record counts in analytics.**
- Accessibility: 44px targets, semantic headings, aria-labels with units, 200% zoom safe, `prefers-reduced-motion` respected, fully usable with audio off.

## Copy rules (grep-enforced, banned phrases)
BANNED: "we detected", "caused", "diagnos*", "normal", "abnormal", "healthy", "unhealthy", "you should", "all clear".
REQUIRED disclaimer (onboarding, Settings→About, export cover): "Rallenta is a wellness journal, not a medical device. It does not measure vital signs, diagnose conditions, or provide medical advice."
Plausibility prompt: "That value is outside the range usually accepted by this field. Check the number and unit, or save it as entered." — [Check again] [Save as entered].
Sleep debt label: "Sleep-target gap estimate — against your chosen target, not a physiological measurement."
Use "You logged…", "appeared alongside", never causal/diagnostic language.

## Audio (audio worker)
- `rain-bed-rallenta-v1.mp3`: synthesized rain bed, loop-safe, ~5 min, stereo, comfortable loudness, no abrupt transients.
- `ambient-pad-rallenta-v1.mp3`: synthesized warm pad, loop-safe, ~5 min, stereo.
- Synthesize with numpy → WAV 48kHz → MP3 (libmp3lame, ~128kbps). Loop-safe: integer modulation cycles + equal-power crossfade at zero-safe regions.
- `audio/manifest.json`: `{tracks:[{id,title,family:'rain'|'ambient',file,duration_s,sha256,bytes,version:1}]}`.
- Player (UI worker `player.js`): play/pause, scrub, timer 15/30/45/60 min with 30s fade-out, seamless loop, never autoplay. Verify files decode in Chrome Android (ffprobe + actually playable stream).
- Keep each file ≤ ~5MB.

## QA gates (before "ready to push")
- `node --check` all JS. Copy-rule grep clean. No private values in URLs/analytics/logs/notifications.
- Data: create/edit/delete each record type, cross-midnight sleep, unit conversion preserves original, export→import round-trip, import conflict preview, migration path.
- Audio decodes, loops without clicks, timer fade works.
- SW installs, app works offline after first load, audio cached.
- Do NOT push to GitHub. Do NOT create a repo.
