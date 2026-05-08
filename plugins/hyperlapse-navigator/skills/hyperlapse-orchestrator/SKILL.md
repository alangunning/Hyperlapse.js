---
name: hyperlapse-orchestrator
description: Plan, implement, configure, and validate playable Hyperlapse.js Street View routes from natural-language journey prompts, including route mode, motion quality, speed, camera/look direction, role intent such as tourist or delivery driver, Google Maps/Routes/Street View API usage, and Chrome/CDP playback verification.
---

# Hyperlapse Orchestrator

Use this skill when a user asks Codex to turn prompt/configuration input into a playable Hyperlapse.js route, or to change the repo’s route planning, Street View prefetching, camera behavior, playback controls, or validation workflow.

## Core Workflow

1. Inspect current files before editing:
   - `examples/demo-route.html`
- `examples/js/JourneyOrchestrator.js`
- `examples/js/VoiceOrchestrator.js`
- `examples/js/TourGuide.js`
- `examples/js/RoutesAdapter.js`
   - `src/Hyperlapse.js`
   - `src/StreetViewTileLoader.js`
2. Choose the correct agent role for the task.
3. For orchestration, summarize operator intent and acceptance criteria, then hand off detailed plan creation to `hyperlapse_plan_writer`.
4. For plan writing, convert the prompt into a concrete `JourneyPlan` file and map it into runtime knobs that already exist in the demo.
5. For playback validation, load the written plan through `hyperlapse_runner`.
6. Implement minimal code changes only when running in a write-capable implementation context and the requested change is not just a route plan.
7. Rebuild generated artifacts when source changes affect `build/hyperlapse.min.js`.
8. Validate with syntax/build checks and, when an API key is available, Chrome/CDP playback.

## Agent Roles

- `hyperlapse_orchestrator`: read-only coordinator. Do not generate detailed `JourneyPlan` JSON. Collect operator intent, define acceptance criteria, request `hyperlapse_plan_writer` to create the plan file, and request `hyperlapse_runner` to play and validate it.
- `hyperlapse_plan_writer`: workspace-write. Write `JourneyPlan` JSON files under `examples/plans/` for local playback.
- `hyperlapse_runner`: read-only. Load existing plan files in the browser and validate playback; do not edit files.

Use `examples/demo-route.html?planUrl=/examples/plans/<file>.json` to load a written plan from a local HTTP server. Use the `plan` query parameter only for encoded transient plans; prefer `planUrl` for repeatable local demos.

For local launches with `.env`, use `npm run demo:route -- --plan=/examples/plans/<file>.json`. The launcher reads `GOOGLE_MAPS_API_KEY` or `GOOGLE_API_KEY` from `.env` or the environment, starts a static server, opens the browser, and does not print the key.

The orchestrator may hand off a concise brief such as origin, destination, role, desired landmarks, travel mode, quality target, and validation requirements. The plan writer owns detailed coordinates, waypoint ordering, camera cue ranges, look-at targets, timing values, sampling density, and the final filename.

## Role Playbooks

### Orchestrator

Use this role when the user is operating the plugin or asking for a route to be generated and played.

Inputs:
- Operator prompt and follow-up corrections.
- Constraints such as route endpoints, travel mode, persona, quality target, desired landmarks, camera behavior, and validation expectations.

Allowed actions:
- Read repo files and existing plans.
- Summarize operator intent.
- Produce handoff instructions for `hyperlapse_plan_writer` and `hyperlapse_runner`.
- Classify runner failures and route them to the right next owner.

Forbidden actions:
- Do not write files.
- Do not generate detailed `JourneyPlan` JSON.
- Do not choose final coordinates, waypoint order, camera cue ranges, look-at targets, timing values, sampling density, or filenames.

Plan-writer handoff should include:
- Original operator prompt.
- Intent summary.
- Required origin/destination if known.
- Persona or route purpose.
- Landmarks or route emphasis.
- Travel mode and motion quality.
- Playback/camera expectations.
- Acceptance criteria.

Runner handoff should include:
- Plan file path.
- Playback URL using `planUrl`.
- Safe API-key handling instructions.
- Validation checks and expected outcome.

### Plan Writer

Use this role when a coordinator brief needs to become a local plan file.

Inputs:
- Coordinator brief and acceptance criteria.
- Any existing plan file to update.

Allowed writes:
- `examples/plans/*.json`
- Minimal validation metadata only when explicitly requested.

Forbidden writes:
- Source files, docs, build outputs, agent profiles, plugin manifests, tests, API keys, `.env`, and unrelated plans.

Plan responsibilities:
- Resolve concrete origin, destination, waypoint, and look-at coordinates.
- Choose waypoint order, purpose text, and view hints.
- Choose travel mode, view mode, motion quality, playback speed, route sampling density, and max points.
- Create ordered, non-overlapping `cameraCues` with normalized `from`/`to` ranges.
- Keep JSON deterministic and pretty-printed with two-space indentation.

Final report should include:
- Plan path.
- Playback URL.
- Key route/camera assumptions.
- Risks or items the runner should verify.

### Runner

Use this role when an existing plan file needs browser validation.

Inputs:
- Plan file path.
- Playback URL using `planUrl`.
- Runtime API-key instructions.
- Validation criteria.

Allowed actions:
- Read files.
- Start and stop a local HTTP server if required.
- Use Chrome/CDP to inspect DOM, canvas, console, and network behavior.

Forbidden actions:
- Do not edit files.
- Do not persist API keys.
- Do not print full keyed URLs.

Validation responsibilities:
- Confirm the plan loads through `planUrl`.
- Confirm the page reaches Ready/Playing or capture the exact error state.
- Inspect console and network failures, especially Maps JavaScript, Routes API, and Street View Map Tiles calls.
- Verify the canvas renders nonblack Street View imagery and frames advance.
- Exercise speed, motion quality, play/pause, and look controls when requested.
- Classify failures as plan-content, API/configuration, browser/runtime, or code defect.

## JourneyPlan Contract

Represent route prompts with this shape:

```js
{
  origin: { lat, lng } | string,
  destination: { lat, lng } | string,
  waypoints: [{ lat, lng, purpose, viewHint, routeVia }],
  travelMode: "DRIVING" | "BICYCLING" | "WALKING",
  viewMode: "follow" | "lookat" | "free",
  motionQuality: "low" | "balanced" | "cinematic",
  speedMetersPerSecond: number,
  distance_between_points: number,
  max_points: number,
  millis: number,
  prompt: string,
  cameraCues: [{ from, to, label, lookat: { lat, lng } }]
}
```

Use these defaults unless the prompt says otherwise:

- Delivery driver: `travelMode: "DRIVING"`, `viewMode: "follow"`, `motionQuality: "balanced"`.
- Tourist/scenic tour: `travelMode` from prompt, `viewMode: "lookat"` for named landmarks, `motionQuality: "cinematic"` for short routes.
- Walking: `travelMode: "WALKING"`, slower speed, dense sampling, and display the required Google beta warning.
- Cycling: `travelMode: "BICYCLING"`, medium speed, dense sampling, and display the required Google beta warning.

Camera interpretation:

- “follow”, “drive toward”, “continue along”, “delivery” -> route-forward view via `follow_route`.
- “look at”, “see”, “swing around”, “tourist” -> fixed or landmark look-at via `lookat` and `use_lookat`.
- “look around”, “free look”, “while playing” -> keep pointer/slider controls live during playback.
- Multiple important places -> choose a default look target per segment when implementing segment-aware camera logic; otherwise use the first named landmark as the demo look-at.

Camera cue rules:

- `from` and `to` are normalized playback progress values from `0` to `1`.
- Use `lookat` coordinates, not place names, so the browser can apply cues without another lookup.
- Keep cues ordered, non-overlapping, and broad enough that each cue lasts long enough to be visible.
- For tourist routes, prefer named historic/cultural landmarks. For delivery-driver routes, prefer forward route visibility and major turn/crossing cues.
- Use `routeVia: false` for landmarks that should influence camera/tour narration but should not be forced into the Routes API path.

## Implementation Map

- Prompt and role parsing lives in `examples/js/JourneyOrchestrator.js`.
- Speech transcript parsing lives in `examples/js/VoiceOrchestrator.js`.
- Voice tourist-guide place lookup and spoken/written place summaries live in `examples/js/TourGuide.js`.
- Current Routes API integration lives in `examples/js/RoutesAdapter.js`; do not reintroduce deprecated `DirectionsService`.
- Playback speed, travel mode, motion quality, and look controls live in `examples/demo-route.html`.
- The `.env` local browser launcher lives in `scripts/launch-demo.mjs`.
- Plan URL loading and camera cue playback live in `examples/demo-route.html`.
- Route-forward camera logic belongs in `src/Hyperlapse.js` as reusable library behavior.
- Street View tile session, metadata, and tile composition belong in `src/StreetViewTileLoader.js`.

## Validation Gates

Run these after relevant changes:

```sh
node --check examples/js/JourneyOrchestrator.js
node --check examples/js/RoutesAdapter.js
node --check src/Hyperlapse.js
node --check src/StreetViewTileLoader.js
npm run build:hyperlapse
npm run validate:plugin
```

When a Google API key is provided, run a local HTTP server and validate in Chrome/CDP:

- route reaches `Ready. Playing demo route.`
- canvas renders nonblack Street View imagery
- no runtime exceptions
- no failed Maps/Routes/Map Tiles requests
- speed, travel mode, motion quality, and look controls update DOM/runtime state

Never commit API keys. Mask keys in logs and search for accidental key persistence before final response.

## Legacy dependency modernization checklist

When asked to modernize dependencies, propose and track:
- Three.js upgrade path from legacy bundle to current npm package.
- Replacement of old Google Maps JS API usage to current recommended loading model.
- Encapsulation of `GSVPano` integration behind a provider adapter.
- Migration from prototype mutation utilities to local pure helpers.
- TypeScript conversion boundary and module decomposition order.

## Guardrails

- Prefer deterministic runtime control over browser UI automation for core playback.
- Keep provider-specific usage behind an adapter.
- Preserve attribution requirements and avoid disallowed caching patterns.
- Keep v1 architecture lean unless user explicitly requests scale infrastructure.
- Treat Google `WALKING` and `BICYCLING` Routes API results as beta and show the warning whenever displayed.
