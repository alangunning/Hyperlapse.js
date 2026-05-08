# Dynamic Street View vs Custom Hyperlapse Player

This note separates what Google Dynamic Street View provides directly from what this project must implement around it.

## Short Answer

Dynamic Street View can replace the custom Three.js viewer for an interactive tour mode, but it does not replace the project.

Google provides the Street View viewer and programmatic camera/location controls. The project still needs to implement route planning, voice and chat intent handling, OpenAI guide answers, route playback, fallback behavior, video export, and cinematic hyperlapse generation.

## Capability Breakdown

| Capability | Provided by Google Dynamic Street View? | Implemented by this project? |
|---|---:|---:|
| Real Street View viewer | Yes | Embed/configure it |
| Drag/look around with mouse/touch | Yes | No custom work required |
| Built-in Street View UI controls | Yes | Optional customization |
| Programmatic heading/pitch/zoom | Yes | Call `setPov()` / `setZoom()` |
| Programmatic move to panorama/location | Yes | Decide when and where to move |
| Events for position/POV changes | Yes | Listen and react |
| Route planning | No | Use Routes API, OpenAI, and/or plan files |
| Moving along a planned route | Partly | Sequence route points and timings |
| Hyperlapse timing/play/pause/reverse | No | Implement playback controller |
| Voice control | No | Implement speech and intent mapping |
| Chat prompt control | No | Implement prompt UI and intent mapping |
| OpenAI route planning | No | Implement backend/OpenAI calls |
| Tourist Q&A | No | Implement with OpenAI, Places, and viewer context |
| Places lookup around current view | Places API provides data | Decide what to query and how to answer |
| Identify visible buildings | No direct built-in feature | Use POV, Places candidates, and optional image model |
| Video export/download | No | Implement, easier from a canvas pipeline |
| Frame interpolation | No | Implement with a video frame interpolation model |
| Custom quota fallback | No | Implement Map Tiles / Static / Dynamic source policy |

## What Dynamic Street View Gives Us

Dynamic Street View is useful when the goal is interactive exploration. It gives us:

- A native Google Street View viewer.
- Built-in user drag/look-around behavior.
- Programmatic camera control through `getPov()`, `setPov()`, and zoom controls.
- Programmatic movement through `setPosition()` and panorama IDs.
- Events such as POV and position changes.

The voice or chat layer is not part of Google Street View. The app would parse commands like "look left" or "continue" and then call the Dynamic Street View API.

Example flow:

```text
Voice or chat prompt
-> speech-to-text or typed input
-> OpenAI/local intent parser
-> command object
-> StreetViewPanorama.setPov() or setPosition()
-> viewer moves or answers
```

## What The Custom Three.js Player Still Provides

The Three.js player remains valuable when the goal is cinematic or video-like output:

- Exact frame sequencing.
- Custom playback timing and timeline controls.
- Reverse/seek behavior controlled by the app.
- Canvas capture for OpenAI vision requests.
- Canvas recording/download as video.
- Map Tiles, Street View Static, and placeholder fallback policy.
- Future AI frame interpolation for smoother motion.

This is the better path for exportable hyperlapse clips and generated media workflows.

## Recommended Hybrid Architecture

Use a preview-first workflow with three viewer modes:

```text
1. Generate route/tour plan with OpenAI, Codex, Routes API, and Places.
2. Preview the route interactively with Dynamic Street View.
3. Adjust route, camera cues, landmarks, pacing, and narration.
4. Only when the plan is accepted, render the final cinematic hyperlapse with Map Tiles / Three.js.
```

This avoids spending large amounts of Map Tiles quota while the user is still experimenting with prompts and route ideas.

1. **Dynamic Street View Mode**
   - Best for interactive guided tours.
   - Avoids the Map Tiles `Street View Tiles requests per day` quota.
   - Uses Dynamic Street View billing/quota instead.
   - Supports user drag/look-around naturally.
   - The app still controls route stepping, voice/chat actions, and guide answers.
   - Recommended as the default plan preview surface.

2. **Three.js Cinematic Mode**
   - Best for generated hyperlapse playback.
   - Uses Map Tiles or Static Street View imagery as frame sources.
   - Supports export, frame interpolation, custom overlays, and exact frame control.
   - Recommended as the final render/export engine after the preview has been approved.

3. **Static Fallback Mode**
   - Best when Map Tiles daily quota is exhausted.
   - Uses Street View Static API images.
   - Keeps the demo visible, but it is not a true 360-degree pano pipeline.

## Programmatic Route Preview With Dynamic Street View

Dynamic Street View supports point-by-point route preview because the app can set the panorama location and camera orientation programmatically.

For route movement:

```js
panorama.setPosition(routePoint);
```

For camera direction:

```js
panorama.setPov({
  heading: headingTowardNextPoint,
  pitch: 0
});
```

For known panorama IDs:

```js
panorama.setPano(panoId);
```

For reading viewer state back into the tour guide:

```js
const position = panorama.getPosition();
const pov = panorama.getPov();
const panoId = panorama.getPano();
const links = panorama.getLinks();
```

The project would still own route timing, route-point sequencing, voice/chat intent handling, pause/continue behavior, Places lookup, OpenAI guide answers, and camera-cue interpretation.

## Quota And Cost Strategy

Map Tiles Street View imagery is tile/frame oriented. Dense hyperlapse generation can burn through the `Street View Tiles requests per day` quota quickly, especially while iterating on route prompts.

Dynamic Street View is a better preview surface because it avoids the Map Tiles Street View tile quota. It uses Dynamic Street View billing/quota instead, so it is not free, but it is better aligned with interactive preview.

Recommended policy:

- Use **Dynamic Street View** for draft previews, interactive route review, and prompt iteration.
- Use **Map Tiles + Three.js** only for accepted final cinematic renders.
- Use **Street View Static API** when Map Tiles quota is exhausted but the UI still needs visible imagery.
- Show the active source mode and quota state clearly in the UI.
- Track local Map Tiles usage so quota exhaustion is obvious during development.

## Product Decision

The custom Three.js player is not strictly required for "navigate a planned route and control the view with voice/chat."

It is still required if the product goal is a controllable, exportable, cinematic hyperlapse/video generation engine.

## References

- Dynamic Street View guide: https://developers.google.com/maps/documentation/javascript/streetview
- StreetViewPanorama reference: https://developers.google.com/maps/documentation/javascript/reference/street-view#StreetViewPanorama
- Dynamic Street View billing behavior: https://developers.google.com/maps/documentation/javascript/usage-and-billing
- Street View Static API overview: https://developers.google.com/maps/documentation/streetview/overview
- Map Tiles API usage and quota behavior: https://developers.google.com/maps/documentation/tile/usage-and-billing
