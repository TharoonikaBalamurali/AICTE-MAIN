# Recorded end-to-end demo

`npm run demo` drives the real portal through its UI as eight seeded roles, records a 1080p video, and writes a report that says which steps actually succeeded.

## Run

```bash
npm install
npx playwright install ffmpeg
npm run demo
```

The script starts the dev server if `http://localhost:3000` isn't already up, and stops it again at the end. It uses the installed Microsoft Edge (`DEMO_BROWSER_CHANNEL=chrome` to switch). Video conversion needs an FFmpeg with libx264: set `FFMPEG_PATH`, or `pip install imageio-ffmpeg`, or put `ffmpeg` on PATH.

Options (environment variables):

| Variable | Default | Effect |
|---|---|---|
| `DEMO_HEADED` | `0` | `1` shows the browser window while it runs |
| `DEMO_PACE` | `1` | Slows everything: pauses, cursor travel, typing and title cards, plus a reading pause after each caption when above 1. `2` gives a ~12-minute walkthrough; use it with a large `DEMO_TARGET_SECONDS` so no sped-up cut is made |
| `DEMO_TARGET_SECONDS` | `300` | Length of the sped-up cut; set high to skip it |
| `DEMO_BASE_URL` | `http://localhost:3000` | Portal address |
| `DEMO_APPLICANT_PASSWORD`, `DEMO_OFFICIAL_PASSWORD` | seeded dev passwords | Account passwords |

## What it shows

One new Diploma-to-Degree conversion application, from draft to Executive Committee decision:

1. Institution fills every required field, uploads the Format 2 NOC and Format 3 resolution with DSC declarations, runs validation and submits.
2. Scrutiny official reviews the rule-based checks report and issues a correction notice on the NOC reference.
3. Institution corrects the field and submits the correction package.
4. Re-scrutiny official records the item as resolved, completes re-scrutiny and approves the EVC handoff.
5. Regional Officer schedules a virtual EVC on the first slot where all three demo members are free, fills the required seats and sends invitations.
6. Each committee member accepts in their own portal; the Regional Officer confirms the visit.
7. A committee member starts the visit, records attendance, uploads the inspection report and submits the final report.
8. Regional Officer forwards the case; the EC official records the decision with a signed letter.
9. Institution sees the decision, workflow history, compliance page and notifications.

After each stage the script reads the application's status from the API and fails the step if the server doesn't agree, so the report can't claim a step that didn't happen.

## Output

`demo/output/<run-id>/` (git-ignored):

- `AICTE_Approval_Portal_Demo.mp4`: full-speed recording, 1920×1080, 30 fps
- `AICTE_Approval_Portal_Demo_5min.mp4`: the same footage sped up to the target length (only when the full video is longer)
- `raw-recording.webm`: untouched Playwright capture
- `REPORT.md` / `report.json`: per-step PASS/FAIL, server status observed, timings; overall PASS only if every step passed and the application ended in `DECISION_ISSUED`
- `NARRATION.md`: timestamped narration (the on-screen captions) for a voice-over
- `screenshots/`: one per step, plus `FAIL-*.png` for a failing step
- `assets/`: the synthetic PDFs that were uploaded

The process exits non-zero when any step fails.

## Data

It uses the seeded demo institution and test accounts, never resets or deletes anything, and creates one new application per run (plus its EVC booking). A run that fails part-way leaves that application at the stage it reached.
