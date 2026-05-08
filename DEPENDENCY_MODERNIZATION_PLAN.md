# Dependency Modernization Plan

## Goal

Upgrade all legacy runtime dependencies to modern supported alternatives while preserving current feature parity and enabling AI-orchestrated hyperlapse journeys.

## Current legacy dependencies (repo)

- `examples/js/three.min.js` (legacy bundled build).
- `examples/js/GSVPano.js` (modified historical integration).
- Google Maps JS API v3.12 style usage in examples/README.

## Target replacements

1. **Three.js (modern npm package)**
   - Replace static `examples/js/three.min.js` usage with npm-managed `three`.
   - Refactor renderer/camera/material calls to current API expectations.

2. **Street View provider adapter layer**
   - Encapsulate direct Google API and `GSVPano` behavior behind:
     - `RouteProvider`
     - `StreetViewProvider`
     - `FrameAssembler`
   - This allows replacing legacy `GSVPano` internals incrementally.

3. **Maps JS loading and routing**
   - Use key-scoped, callback-safe loader patterns.
   - Move route creation into modular service file.

4. **Utility hygiene**
   - Remove `Number.prototype` and `Array.prototype` mutations.
   - Introduce local helper functions (`toRad`, `toDeg`, `arrayRemoveRange`).

## Phased sequence

### Phase A - Tooling baseline
- Introduce package manager metadata and lockfile.
- Add lint + format + basic test harness.

### Phase B - Rendering isolation
- Isolate player rendering into a module independent from route fetch logic.
- Upgrade to modern Three.js and update deprecated calls.

### Phase C - Provider isolation
- Add provider adapter interfaces and migrate callsites.
- Replace direct global `google.maps` assumptions where possible.

### Phase D - Orchestration integration
- Add `JourneyPlan` JSON contract and deterministic executor.
- Add prefetch manifest generation and resume anchor serialization.

### Phase E - Recording/export hardening
- Keep MediaRecorder support and add capability matrix checks.
- Add predictable recording lifecycle hooks and QA matrix.

## Definition of done

- Legacy bundled dependencies replaced or isolated behind adapters.
- Examples run with modern loading pattern.
- Core hyperlapse playback tests pass.
- Prompt -> plan -> route -> preload -> play flow is deterministic.
- Skill and plugin scaffolding available for Codex-driven orchestration.
