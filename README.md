# **Hyperlapse.js**

### JavaScript hyper-lapse utility for Google Street View.

![image](https://s3.amazonaws.com/tllabs.hyperlapse/hyperlapse.gif)

This library was written to create dynamic hyper-lapse (time-lapse with movement) sequences using Google Street View. 

[See it action.](http://hyperlapse.tllabs.io)

[Read about this project.](http://www.teehanlax.com/labs/hyperlapse/)

[Video of what's possible.](https://vimeo.com/63653873)

## Example

[Simple example](http://tllabs.io/hyperlapse/examples/simple.html)

Local clone demo route:

- Open `examples/demo-route.html?key=YOUR_GOOGLE_MAPS_API_KEY`
- Or store `GOOGLE_MAPS_API_KEY` in `.env` and run `npm run demo:route`
- Includes a ready-to-run short Dublin route: 3Arena -> O'Connell Street
- Includes a prompt box + `JourneyOrchestrator` + voice controls for play/pause/next/prev/reroute, look, tourist guide commands, and optional OpenAI-backed prompt interpretation
- The same key must have the APIs listed in [Google API key setup](#google-api-key-setup) enabled.

## Google API Key Setup

Create a key in the [Google Cloud Console](https://console.cloud.google.com/):

1. Create or select a project.
2. Enable billing for the project.
3. Enable these APIs under **APIs & Services > Library**:
   - Maps JavaScript API
   - Routes API
   - Geocoding API
   - Elevation API
   - Map Tiles API
   - Places API or Places API (New), for the voice tourist guide lookup in `examples/demo-route.html`
4. Create an API key under **APIs & Services > Credentials**.
5. Restrict the key before using it outside local development:
   - Application restriction: **HTTP referrers**.
   - Local development example: `http://localhost:*/*`.
   - Deployed site example: `https://your-domain.com/*`.
   - API restrictions: restrict to the APIs listed above.

For the static examples in this repo, pass the key in the page URL:

```text
examples/demo-route.html?key=YOUR_GOOGLE_MAPS_API_KEY
examples/simple.html?key=YOUR_GOOGLE_MAPS_API_KEY
examples/viewer.html?key=YOUR_GOOGLE_MAPS_API_KEY
```

If you serve the examples locally, open them through a local HTTP server so HTTP referrer restrictions work predictably:

```sh
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/examples/demo-route.html?key=YOUR_GOOGLE_MAPS_API_KEY
```

Do not commit real keys. Local `.env` files are ignored by this repo, but plain static HTML cannot read `.env` directly. Environment variables only help if you add a backend or build step. For production, use a restricted browser key for Maps JavaScript API and consider proxying Map Tiles API calls through a backend that reads a server-only key from `.env`.

For local development, the repo includes a small launcher that reads `.env`, starts a static server, and opens the route demo without printing the key:

```sh
cp .env.example .env
# set GOOGLE_MAPS_API_KEY in .env
npm run demo:route
```

To open the shorter default plan explicitly:

```sh
npm run demo:route -- --plan=/examples/plans/three-arena-oconnell-street.json
```

To open the longer historical Heuston tour:

```sh
npm run demo:route -- --plan=/examples/plans/three-arena-heuston-history.json
```

Optional OpenAI interpretation:

```sh
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
OPENAI_MODEL=gpt-5.5
OPENAI_GUIDE_ATTACH_STREETVIEW_IMAGE=false
```

When `OPENAI_API_KEY` is present and you launch with `npm run demo:route`, the local launcher exposes same-origin OpenAI helper endpoints. The browser sends voice/chat transcript text and current viewer context to `/api/openai/interpret`; the server calls the OpenAI Responses API and returns a structured viewer command, place lookup intent, or route plan. Tourist-guide answers use Google Places results as grounded data, then `/api/openai/guide-answer` formats the written/spoken guide response. The OpenAI key is never sent to browser JavaScript.

Set `OPENAI_GUIDE_ATTACH_STREETVIEW_IMAGE=true` to also attach the current rendered Street View frame to guide-answer requests. The browser captures the current WebGL viewer canvas, downscales it to a compact JPEG data URL, and sends it to the local `/api/openai/guide-answer` endpoint with up to 16 nearby Google Places candidates. The local server then includes that image in the OpenAI Responses API request. This lets the guide choose a visible candidate such as a convention centre even when local bearing/distance scoring picked the wrong nearby venue. Keep it off when you want lower cost and less image data sent to OpenAI.

If `OPENAI_API_KEY` is absent, or if the OpenAI request fails, the demo keeps using the local deterministic intent mapper in `VoiceOrchestrator.js` for play/pause/look/identify/reroute commands.

```js
var hyperlapse = new Hyperlapse(document.getElementById('pano'), {
	lookat: new google.maps.LatLng(37.81409525128964,-122.4775045005249),
	zoom: 1,
	use_lookat: true,
	elevation: 50,
	streetViewApiKey: "YOUR_GOOGLE_MAPS_API_KEY"
});

hyperlapse.onError = function(e) {
	console.log(e);
};

hyperlapse.onRouteComplete = function(e) {
	hyperlapse.load();
};

hyperlapse.onLoadComplete = function(e) {
	hyperlapse.play();
};

hyperlapse.onRecordComplete = function(e) {
	// Save short completed journey capture
	hyperlapse.downloadRecording("my-hyperlapse.webm");
};

var route = {
	request:{
		origin: new google.maps.LatLng(37.816480000000006,-122.47825,37),
		destination: new google.maps.LatLng(37.81195,-122.47773000000001),
		travelMode: "DRIVING"
	}
};

GoogleRoutesAdapter.computeRoute(route.request).then(function(response) {
	hyperlapse.generate( {route:response} );
}).catch(function(error) {
	console.log(error.message);
});

// start recording before playback (browser must support MediaRecorder)
hyperlapse.startRecording({ frameRate: 30 });

// stop recording whenever the short clip is complete
// hyperlapse.stopRecording();
```

## Recording export

Hyperlapse.js now includes simple recording helpers for exporting a short clip:

- `startRecording({ mimeType, videoBitsPerSecond, frameRate })`
- `stopRecording()`
- `getRecording()` returns the generated `Blob` (or `null`)
- `downloadRecording(filename)` triggers a `.webm` download

Recording uses `MediaRecorder` + `canvas.captureStream()`, so support depends on the browser.

## Playback tuning

`examples/demo-route.html` exposes separate controls for:

- Travel mode: drive, cycle, or walk.
- Motion quality: route sampling density before Street View panorama IDs are resolved.
- Point spacing: the exact `distance_between_points` route sampling distance used for the next generated route.
- Street View tiles: Map Tiles API zoom level for panorama composition. Higher values are sharper but fetch more tiles and reload the current route frames.
- Speed: playback multiplier. Lower values are slower; higher values are faster.
- Timeline: seek to any loaded frame and step forward/backward.
- Direction: play forward or reverse through the loaded sequence.
- View mode and accessible look controls: follow the route, look at a waypoint, or use arrow buttons/free-look while playback continues.

Use **Cinematic** motion quality for smoother, more movie-like motion. It samples the route more densely and allows more panorama frames, so it costs more API calls and takes longer to preload. Use **Low frame rate** when fast generation is more important than smooth motion.

Future work: the roadmap includes an optional AI frame-interpolation pipeline for creating generated in-between frames between sparse Street View panoramas. FILM from Google Research is listed as one baseline candidate, including hosted no-local-GPU experiments through Replicate, but the plan is to evaluate maintained Hugging Face, ComfyUI, and street-scene-specific approaches before choosing an implementation. See `docs/AI_TOUR_GUIDE_ROADMAP.md`.

## Voice tourist guide

`examples/demo-route.html` turns final Web Speech transcripts into viewer actions. With `OPENAI_API_KEY` configured through the local launcher, freeform voice and chat prompts are interpreted by OpenAI first. Without it, or when the request fails, the local rule-based mapper remains the fallback:

- “turn left”, “look right”, “look up”, “look down”, “look ahead”
- “stop”, “pause”, “play”, “continue”, “next”, “previous”
- “go to Smithfield” or another Dublin destination
- “what is that building on the right?”
- “stop and look at that building on the left, what is it?”
- “tell me about what I am looking at”

Look commands switch the viewer into free-look mode and update the look sliders. Tourist guide questions pause when requested, turn toward the requested direction, query nearby Google Places around the current Street View frame, write the result into the Tour guide field, and speak it with browser `speechSynthesis` when available.

The same tourist questions can be typed into the **Ask the guide** input. The demo prefetches nearby Places candidates as frames render and as the user looks around, so common questions like “what building am I looking at now?” can reuse cached place names before falling back to a fresh Places lookup.

## Dependencies

- [Three.js](https://github.com/mrdoob/three.js) `0.184.0`
- Google Maps JavaScript API `v=weekly`
- Google Map Tiles API Street View Tiles

The old modified `GSVPano.js` dependency has been replaced with the local `src/StreetViewTileLoader.js` implementation. It uses the supported Map Tiles API session, metadata, and Street View tile endpoints instead of the legacy `cbk` tile endpoint.

## Modern Street View approach

For new product work, prefer the official Map Tiles API Street View flow used here: create a Street View tile session, resolve route locations to transient pano IDs/metadata, compose tiles into an equirectangular texture, then render with Three.js. If you do not need custom camera interpolation or exportable canvas frames, the built-in `google.maps.StreetViewPanorama` viewer is simpler and handles attribution/UI for you.

  
## API Docs 
  
[API Documentation](http://tllabs.io/hyperlapse/docs/Hyperlapse.html)

## Modernization and orchestration resources

- `MODERNIZATION_REVIEW.md` - architecture and migration strategy.
- `DEPENDENCY_MODERNIZATION_PLAN.md` - dependency upgrade and replacement sequence.
- `VOICE_MODE_PLAN.md` - OpenAI voice mode and live transcription rollout plan.
- `plugins/hyperlapse-navigator/.codex-plugin/plugin.json` - Codex plugin manifest for orchestration.
- `plugins/hyperlapse-navigator/skills/hyperlapse-orchestrator/SKILL.md` - Codex skill for route/planning/prefetch orchestration tasks.
- `.codex/agents/hyperlapse_orchestrator.toml` - read-only agent profile that uses the Hyperlapse orchestrator skill.
  

## License

The MIT License

Copyright (c) 2013 Teehan+Lax

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
