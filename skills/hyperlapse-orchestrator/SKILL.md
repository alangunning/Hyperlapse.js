# Hyperlapse Orchestrator Skill

## Purpose

Use this skill to coordinate modernization and orchestration tasks for Hyperlapse.js, including:
- dependency modernization planning,
- natural-language journey planning contracts,
- deterministic route execution design,
- Street View prefetch planning,
- demo/runtime verification checklists.

## Inputs expected

- User journey request (plain language), optionally with landmarks.
- Deployment constraints (e.g. no queue/no DB/no OTel in v1).
- Provider constraints (Google Maps/Street View usage and attribution requirements).

## Workflow

1. **Normalize user intent** into a structured `JourneyPlan`.
2. **Resolve route primitives** (origin, waypoints, destination, optional transit semantics).
3. **Validate Street View coverage** and produce fallback detours.
4. **Build frame prefetch manifest** with priority and cancellation support.
5. **Emit deterministic execution package**:
   - `journey-plan.json`
   - `waypoint-graph.json`
   - `prefetch-manifest.json`
   - `resume-state.json`
6. **Generate operator checklist** for run/start/pause/explore/resume/export.

## Output contract

Return a concise package summary with:
- selected route,
- fallback route policy,
- estimated frame count,
- expected duration,
- identified risk flags.

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
