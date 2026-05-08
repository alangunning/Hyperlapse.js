# AI Tour Guide Roadmap

This document captures future enhancements for turning the Hyperlapse Navigator demo into a shareable Codex/OpenAI-powered tourist guide experience.

## Goal

Make a demo where Codex can generate a playable Street View hyperlapse plan from a natural-language route prompt, then let a user interrupt playback by voice or text to ask tourist questions about what they are seeing.

## Product Direction

The strongest demo loop:

1. User gives a route prompt.
2. Codex generates a local `JourneyPlan` with route, motion quality, camera cues, and narration intent.
3. The browser launches the route with the local API key from `.env`.
4. The user can speak or type commands such as:
   - "What is that building on the right?"
   - "Pause and tell me what I am looking at."
   - "Look left."
   - "What else is nearby?"
5. The app turns the request into viewer actions, Places lookup, and a concise tourist-guide answer.
6. The demo can record or share the generated tour.

## Recommended Architecture

- Browser:
  - Renders Hyperlapse.js and Street View frames.
  - Captures voice or text prompts.
  - Executes structured UI actions: pause, play, seek, look, identify, narrate.
- Local/backend server:
  - Reads API keys from `.env`.
  - Calls OpenAI APIs.
  - Optionally proxies Google Places/Routes calls so keys are not exposed to browser JavaScript.
- Codex plugin:
  - Coordinates route requests.
  - Delegates detailed plan generation to the plan-writer agent.
  - Delegates playback/browser validation to the runner agent.
- Google APIs:
  - Routes API for travel path.
  - Map Tiles API for Street View tile rendering.
  - Places API for named place candidates around the current panorama.
- OpenAI APIs:
  - Responses API for transcript/text-to-action structured output.
  - Realtime API for natural low-latency voice interaction.

## Enhancement Tracks

### 1. AI Intent Layer

Replace hardcoded transcript parsing with a model-backed structured action parser.

Input:

```json
{
  "transcript": "stop and look at that building on the right, what is it?",
  "viewerState": {
    "lat": 53.34,
    "lng": -6.25,
    "heading": 88,
    "frame": 142,
    "nearbyPlaces": []
  }
}
```

Output:

```json
{
  "actions": [
    { "type": "pause" },
    { "type": "look", "direction": "right" },
    { "type": "identify_place", "direction": "right" },
    { "type": "answer", "mode": "speak_and_write", "style": "curious_tourist_guide" }
  ]
}
```

Use a strict schema so the browser only executes known action types.

### 2. AI Tourist Narration

Use Places results and viewer state as factual context, then ask the model for concise guide narration.

Context should include:

- Current Street View location.
- Camera heading and requested direction.
- Nearby Places candidates.
- Active route cue.
- User interest profile, if known.
- Recent tour memory.

The answer should be grounded in supplied data, with uncertainty when the place cannot be confidently identified.

### 3. Realtime Voice

Move beyond browser Web Speech API to a realtime voice agent:

- User interrupts playback naturally.
- App pauses or changes view while the user speaks.
- Assistant responds with low-latency spoken narration.
- Tool calls update the viewer in real time.

Realtime voice should still route through structured tool calls. Do not let freeform model text directly drive arbitrary DOM actions.

### 4. Place Prefetching

At each loaded or displayed frame:

- Cache nearby places around the current Street View location.
- Cache places offset ahead, left, and right from the current camera heading.
- Score candidates by distance, bearing, type, and route/tour context.
- Use the cache to answer expected questions quickly.

This should avoid image analysis for most named landmarks and buildings. Vision can be added later for ambiguous facades, signs, statues, or when Places has no useful candidate.

### 5. Codex-Generated Tour Assets

Extend the plan writer to generate richer plans:

- Route and route-shaping points.
- Camera cues.
- Narration cues.
- Points of interest with expected Places queries.
- Voice prompt suggestions.
- Tour title and share description.
- Validation criteria for the runner agent.

### 6. Shareable Demo

Add a one-click flow:

- Generate tour.
- Preview tour.
- Record a short `.webm`.
- Share route config and preview clip.

This is the viral surface: a personalized AI-generated Street View tour that can be replayed and shared.

### 7. AI Frame Interpolation For Cinematic Motion

Street View panoramas are sparse. Even with dense route sampling, Google may return the same panorama for nearby route points or jump to the next available panorama farther down the street. That creates visible gaps in motion, especially when the route turns or when the user is looking sideways at buildings.

Explore an optional post-processing pipeline that synthesizes in-between frames between loaded Street View frames so the final hyperlapse feels closer to continuous video.

Candidate approaches:

- FILM: Google's "Frame Interpolation for Large Motion" model. FILM was published at ECCV 2022 and is designed to synthesize slow-motion video from near-duplicate photos with large scene motion. The project page and source are available at:
  - https://film-net.github.io/
  - https://github.com/google-research/frame-interpolation
- More recent video frame interpolation models that may be faster, more temporally stable, easier to run locally, or better suited to street scenes.
- Street-scene-specific approaches that combine geometry with learned interpolation, such as depth-aware warping, optical flow, or 3D-aware view synthesis.

Do not assume FILM is the final solution. Treat it as a strong baseline to evaluate because it is open source and explicitly targets large motion between related images. The Google Research repository is archived/read-only, so production work should compare it against maintained alternatives before committing to an implementation.

No-local-GPU execution options:

- Replicate hosted FILM:
  - https://replicate.com/google-research/frame-interpolation/api
  - Useful for quick experiments when the developer machine has no NVIDIA GPU.
  - Best first use: submit pairs of rendered Street View frames and compare different interpolation counts on short clips.
  - Keep this behind a local/backend endpoint. Do not put a Replicate API token in browser JavaScript.
- Hugging Face:
  - Search Hugging Face for maintained frame interpolation models and Spaces rather than assuming one canonical package.
  - The ecosystem includes FILM, RIFE, and ComfyUI-oriented checkpoint collections such as `Comfy-Org/frame_interpolation`.
  - Useful paths include hosted Spaces for manual comparison, Inference Endpoints for an API-style prototype, or a GPU Space for a custom pipeline.
  - Keep options open for newer VFI models such as RIFE variants, GMFSS, AMT, EMA-VFI, GIMM-VFI, Mamba/Transformer-based VFI, and diffusion-assisted interpolation if they handle Street View jumps better than FILM.
- Hosted ComfyUI:
  - ComfyUI frame-interpolation workflows can test multiple VFI nodes without wiring every model directly into this repo.
  - Candidate nodes/workflows include FILM VFI, RIFE VFI, GMFSS, AMT, and other ComfyUI-Frame-Interpolation suites.
  - This is especially useful for visual bake-offs: export route frames, run several workflows, then compare artifacts and smoothness before implementing an automated pipeline.

Hosted pipeline sketch:

1. Browser/local renderer exports a short frame-pair batch or a full route frame sequence.
2. Local backend uploads only the needed rendered frames to the hosted provider.
3. Provider returns interpolated frames or a rendered video clip.
4. Backend stores the output under a cache directory keyed by plan hash, frame hash, provider, model, and settings.
5. Browser plays the cached interpolated clip or mixed real/synthetic frame sequence.

Provider selection should be configurable:

```json
{
  "interpolation": {
    "enabled": true,
    "provider": "replicate | huggingface | comfyui | local",
    "model": "google-research/frame-interpolation | rife | film | custom",
    "framesBetween": 3,
    "mode": "preview | cinematic | export"
  }
}
```

Possible architecture:

1. Load the normal Hyperlapse Street View frames from Map Tiles API.
2. Export each rendered frame as an image with associated metadata:
   - frame index
   - pano ID
   - lat/lng
   - camera heading
   - camera pitch
   - route distance
   - timestamp target
3. For each adjacent frame pair, estimate how many synthetic frames are needed based on:
   - distance jump
   - heading change
   - current playback speed
   - selected quality mode
   - whether the view is forward, side-looking, or landmark-focused
4. Run interpolation offline or through a local worker/server, not directly in the browser at first.
5. Cache generated interpolated frames by a stable hash of:
   - source frame A
   - source frame B
   - camera headings
   - interpolation model/version
   - interpolation count
6. Play back a mixed sequence of real Street View frames and generated in-between frames.

Quality modes could map to interpolation levels:

- `low`: no interpolation; fastest and cheapest.
- `balanced`: interpolate only large visual jumps or sharp turns.
- `cinematic`: interpolate most adjacent Street View frames and target video-like pacing.
- `offline render`: generate a high-quality export that may take minutes but produces the smoothest shareable clip.

Important risks:

- Hallucinated geometry: generated frames may invent signs, people, vehicles, storefronts, or architectural details.
- Place-identification mismatch: Places answers should stay grounded in real Google Places data and the nearest real Street View frame, not generated pixels.
- Legal/product constraints: generated frames derived from Street View imagery need careful review against Google Maps Platform terms before sharing or distributing.
- Provider/privacy constraints: hosted interpolation sends rendered Street View-derived frames to a third-party service. This needs terms, data retention, and user disclosure review.
- Key handling: Replicate, Hugging Face, or hosted ComfyUI tokens must stay server-side in `.env`, never in browser JavaScript or shareable plan JSON.
- Runtime cost: high-quality interpolation may need GPU execution and should likely run server-side or offline.
- Temporal artifacts: interpolation can smear cars, pedestrians, poles, signs, and building edges.
- User trust: the UI should clearly distinguish real Street View frames from AI-smoothed video when exported or shared.

Validation criteria:

- Compare original vs interpolated playback at the same route and speed.
- Measure perceived smoothness around turns and long panorama jumps.
- Inspect artifacts on street signs, vehicles, pedestrians, building facades, and bridge/rail structures.
- Run the same frame pairs through at least FILM-on-Replicate, one Hugging Face/ComfyUI FILM path, and one non-FILM model such as RIFE or a newer VFI model.
- Ensure the guide still answers from Places/route metadata rather than generated imagery.
- Verify export frame rate, file size, and generation time are acceptable for a viral demo.

## Implementation Order

1. Add a local backend endpoint `/api/voice-intent`.
2. Replace `VoiceOrchestrator.parseCommand()` with model-backed structured parsing, keeping hardcoded parsing as offline fallback.
3. Add `/api/tour-answer` to turn Places candidates plus viewer state into a guide answer.
4. Add place prefetching around the current frame and visible directions.
5. Add narration cues to `JourneyPlan`.
6. Add recording/share controls.
7. Add an offline interpolation experiment for short exported clips.
8. Add Realtime voice after the text/action loop is solid.

## Safety And Key Handling

- Never commit real API keys.
- Browser demos may use restricted browser keys for Google Maps APIs during local development.
- OpenAI API keys should not be exposed to browser JavaScript.
- Use a backend or local launcher that reads `.env`.
- Log only sanitized URLs and request summaries.

## Open Questions

- Should Google Places calls stay in browser with a restricted key, or move server-side?
- Should the tour-answer model cite only Places metadata, or also use web search for historical enrichment?
- Should generated plan files include narration text directly, or should narration be produced dynamically at runtime?
- How much route state should be persisted for shareable links?
