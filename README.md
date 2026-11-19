# Triad — Self Insight PWA

Offline-first PWA for tracking:
1. Situations
2. Thoughts
3. Behaviours

## Run
Serve this folder over HTTP (service workers require localhost/HTTPS):
`python -m http.server 8080`

Open http://localhost:8080

## Architecture
- UI: semantic HTML + CSS, mobile-first
- State: small explicit UI state object
- Persistence: IndexedDB
- Offline: service worker cache
- Insights: explainable rule-based pattern engine
- Export: local JSON
- Future AI: optional adapter layer; keep raw journal data local by default

## Product principle
Insights are hypotheses, not diagnoses. The app should show the evidence behind each insight.

## Releasing

Bump `VERSION` in `sw.js` on every release. The offline cache is named after it, and every other cache is deleted when the new version activates, so users pick up the new code on their next visit.

## Backup

Settings has Export and Import. Exports carry a `schemaVersion`; importing the same file twice does not create duplicates, and invalid records are skipped and reported.
