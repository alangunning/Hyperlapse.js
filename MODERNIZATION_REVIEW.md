# Hyperlapse.js Modernization Review (2026)

## 1) Current-state assessment

This repository is a strong 2013 proof-of-concept that stitched together:
- Google Directions API polyline sampling,
- Street View panorama preloading via a modified `GSVPano`,
- A Three.js sphere renderer for immersive playback.

It still demonstrates the core pattern for "route -> pano sequence -> playback", but multiple architectural assumptions are now outdated.

### Strengths that should be preserved

1. **Clear event lifecycle** (`onRouteProgress`, `onRouteComplete`, `onLoadProgress`, `onLoadComplete`, `onFrame`, etc.) that maps well to modern async pipelines.
2. **Deterministic path sampling approach** (`distance_between_points`, `max_points`) that can still be useful as a fallback route densification strategy.
3. **Preload-then-play UX**, which remains important for smooth hyperlapse.

### Modernization blockers

1. **Global prototype mutation** (`Number.prototype`, `Array.prototype`) creates compatibility risk in modern JS ecosystems.
2. **Legacy dependency stack** (Three.js r57-era APIs, Canvas renderer fallback, older Google Maps JS API usage).
3. **Monolithic class combining route planning, network I/O, pano processing, and rendering in one unit.**
4. **No structured control plane for pause/explore/resume against a persistent route intent.**
5. **No formal policy/compliance guardrails in code for Google Maps Platform terms and attribution handling.**

## 2) What in the existing code maps to your target product

Your desired flow:
> user prompt -> AI plans route -> app auto-drives hyperlapse -> user can interrupt/explore -> continue planned journey

The current code already contains primitives you can evolve:

- **Route generation pipeline**: `generate()` -> `handleDirectionsRoute()` -> sampled `_raw_points` -> deduped pano points (`_h_points`).
- **Frame transport model**: each `HyperlapsePoint` stores pano ID, heading/pitch/elevation/image metadata.
- **Playback state machine seeds**: play/pause/next/prev and index progression.

What is missing is an orchestration layer that understands natural language goals, route constraints, detours, and resumable intent.

## 3) Recommended target architecture

## 3.1 High-level components

1. **Frontend Player (Web app)**
   - React/Vue/Svelte + WebGL renderer (Three.js current version).
   - Handles rendering, manual look-around, playback controls, timeline.

2. **Journey Orchestrator (Backend service)**
   - Converts high-level journey plans into executable waypoint graphs.
   - Maintains finite-state machine: `PLANNED`, `RUNNING`, `USER_EXPLORE`, `REJOINING`, `COMPLETED`, `ABORTED`.

3. **Route & Street View Provider Adapter**
   - Encapsulates provider APIs (Google preferred if licensing permits your use case).
   - Performs route segmentation and Street View availability checks.

4. **Frame Prefetch Worker**
   - Prioritized queue for pano metadata + tile/image loading.
   - Adaptive prefetch window based on bandwidth and decode latency.

5. **LLM Planning Service (Codex CLI assisted development + runtime LLM tool-calling)**
   - Runtime: convert prompt into structured journey JSON.
   - Dev-time: use Codex CLI to scaffold, refactor, test, and evolve planners/tools.

6. **Session Memory / Event Store**
   - Stores journey intent, waypoints, user overrides, and resume anchors.

## 3.2 Control-plane contract (key idea)

Define a provider-agnostic `JourneyPlan` schema:

```json
{
  "intent": "starting at the three arena in Dublin ...",
  "origin": {"place_id": "..."},
  "landmarks": [
    {"name": "Gibson Hotel", "action": "orbit", "duration_sec": 12},
    {"name": "Luas red line", "action": "follow_transit_line", "until": "line_terminus"}
  ],
  "camera_policy": {
    "default_mode": "forward_heading",
    "poi_focus": true
  },
  "interrupt_policy": {
    "allow_user_explore": true,
    "resume_strategy": "nearest_future_anchor"
  }
}
```

Execution artifacts:
- `WaypointGraph` (topological route nodes)
- `StreetViewFramePlan` (ordered pano IDs with headings and timing)
- `ResumeAnchors` every N meters/seconds.

## 3.3 User interrupt/resume behavior

When user drags view or "walks" manually:
1. Transition to `USER_EXPLORE`.
2. Keep planned graph frozen.
3. Continuously compute nearest valid rejoin anchor.
4. On "continue", either:
   - snap to nearest future anchor (recommended), or
   - soft blend camera path over 2–4 seconds.

This preserves agency without losing deterministic journey completion.

## 4) LLM integration strategy (practical)

Use LLM for **planning and clarification**, not direct browser-control as core runtime.

### Preferred pattern

- LLM outputs structured plan (JSON) through tool-calling.
- Deterministic orchestrator validates constraints:
  - geocoding success,
  - waypoint reachability,
  - Street View coverage,
  - max route duration/frame budget.
- Renderer executes deterministic plan.

### Why not pure "LLM drives Chrome via CDP" runtime

CDP-driving is brittle for production route playback:
- fragile selectors/UI flows,
- variable latency,
- hard-to-validate legal/compliance boundaries,
- poor reproducibility.

Use CDP automation mostly for:
- test automation,
- regression capture,
- controlled demos.

## 5) Legal/compliance guardrails (important)

For Google data, implement explicit guardrails before shipping:

1. **Use official APIs and allowed display contexts only.**
2. **Honor attribution and metadata requirements in UI.**
3. **Do not cache/store imagery beyond permitted terms.**
4. **Enforce key restrictions, quotas, and audit logging.**
5. **Build a provider abstraction** so alternative licensed providers can be added if terms change.

(Validate against current Google Maps Platform terms with counsel before production rollout.)

## 6) Suggested refactor phases

### Phase 0: Stabilize and extract
- Port current code to TypeScript module boundaries.
- Remove prototype mutations.
- Split into:
  - `route-sampler`,
  - `pano-resolver`,
  - `frame-cache`,
  - `renderer`,
  - `player-state`.

### Phase 1: Modern player core
- Replace legacy Three.js usage with current APIs.
- Use OffscreenCanvas/Web Workers for decode where available.
- Implement observable state machine for playback + interrupts.

### Phase 2: Orchestrator + schema
- Introduce `JourneyPlan` and `WaypointGraph` contracts.
- Add deterministic planner pipeline with validation.
- Implement a file-backed `SessionStore` first; keep a `SQLiteSessionStore` adapter optional.

### Phase 3: LLM planner
- Add tool-calling endpoints:
  - `geocode_place`,
  - `find_transit_line_path`,
  - `build_streetview_route`,
  - `estimate_duration`.
- Prompt template asks clarifying questions only when necessary.

### Phase 4: Experience polish
- Cinematic camera policies (POI orbit, eased turns, speed ramps).
- "Explore mode" overlay with one-click resume.
- Progress UI with upcoming landmarks.

## 7) Recommended stack (2026-ready, lean-first)

- **Frontend:** TypeScript + React + Three.js + Zustand/Redux Toolkit.
- **Backend:** Node/TypeScript (Fastify/Nest) or Python (FastAPI).
- **Queue:** none initially (in-process scheduler + bounded async worker pool).
- **Storage:** file-based JSON session artifacts first; optional SQLite for resumable sessions.
- **Observability:** structured file logs first (no OpenTelemetry requirement in v1).
- **Testing:** Playwright for UI, contract tests for planner tools, synthetic route fixtures.

## 7.1 Minimal architecture for your current constraint (no queue/DB/OTel)

To match your request, you can ship a capable first version with:

1. **No queue service**
   - Use an in-process prefetch manager with:
     - max concurrency (e.g., 4–8 in-flight fetches),
     - priority ordering (near-future frames first),
     - cancellation tokens on pause/explore.

2. **No external database**
   - Persist session state to local files:
     - `sessions/<sessionId>/journey-plan.json`
     - `sessions/<sessionId>/waypoint-graph.json`
     - `sessions/<sessionId>/resume-state.json`
     - `sessions/<sessionId>/events.ndjson`
   - This keeps the system easy to debug and replay.

3. **Optional SQLite only when needed**
   - Add SQLite if/when you need:
     - concurrent multi-session access,
     - lightweight querying over prior runs,
     - safer crash recovery than flat files alone.
   - Keep a repository pattern so file-backed and SQLite-backed stores are swappable.

4. **No OpenTelemetry in v1**
   - Start with:
     - structured JSON logs,
     - per-session `metrics.json`,
     - error snapshots for failed route plans.
   - Add OpenTelemetry later only if operating scale demands distributed tracing.

## 8) Concrete migration notes from this repo

1. Keep the event semantics but formalize with typed events.
2. Convert recursion-based pano parsing into cancelable async iterators with backpressure.
3. Replace shared mutable arrays with immutable snapshots + ring-buffer caches.
4. Introduce error taxonomy (`ROUTE_UNAVAILABLE`, `SV_GAP`, `QUOTA_LIMIT`, `POLICY_BLOCKED`).
5. Preserve `distance_between_points` as an advanced knob, but add adaptive spacing by curvature and speed.

## 9) Definition of "done" for your requested use case

A request like:
"start at 3Arena, orbit Gibson Hotel, follow Luas to terminus"
should produce:

1. Confirmed geocoded entities and chosen line/terminus.
2. Generated waypoint graph with explainable decisions.
3. Estimated duration and frame count before execution.
4. Smooth autoplay route with continuous prefetch.
5. User can pause/look around/explore.
6. Resume continues planned journey from nearest future anchor.
7. Full attribution and terms-compliant rendering.

---

If you want, next step is I can draft a **v2 repository layout** (`apps/web`, `services/orchestrator`, `packages/planner-schema`, `packages/player-core`) and a minimal JSON tool-calling contract for the LLM planner.
