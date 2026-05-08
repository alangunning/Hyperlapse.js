(function(global) {
	function byId(id) {
		return document.getElementById(id);
	}

	function asLatLng(point) {
		if (!point) return null;
		if (typeof point.lat === "function") return point;
		return new google.maps.LatLng(point.lat, point.lng);
	}

	function DemoRouteApp(options) {
		options = options || {};
		this.pano = byId("pano");
		this.mapElement = byId("route-map");
		this.activeCameraCues = [];
		this.playbackBaseMillis = 560;
		this.seeking = false;
		this.resizeObserver = null;
		this.routeMap = null;
		this.routePolyline = null;
		this.routeMarker = null;
		this.routeClickListener = null;
		this.currentPlan = null;
		this.routeSettingsDirty = false;
		this.reloadingTiles = false;
		this.pendingDownloadName = null;

		this.hyperlapse = new Hyperlapse(this.pano, {
			width: 960,
			height: 540,
			lookat: new google.maps.LatLng(53.349164, -6.227734),
			use_lookat: false,
			follow_route: true,
			zoom: 0,
			millis: 560,
			streetViewApiKey: options.apiKey,
			streetViewStaticBaseUrl: "/api/google/streetview-static",
			streetViewSourceMode: "auto",
			preserveDrawingBuffer: true
		});

		this.geocoder = new google.maps.Geocoder();
		this.voice = new VoiceOrchestrator();
		this.intentInterpreter = global.OpenAIIntentInterpreter ? new OpenAIIntentInterpreter() : null;
		if (this.intentInterpreter && this.intentInterpreter.loadConfig) {
			this.intentInterpreter.loadConfig();
		}
		this.placesService = google.maps.places ? new google.maps.places.PlacesService(document.createElement("div")) : null;
		this.tourGuide = new TourGuide({
			hyperlapse: this.hyperlapse,
			placesService: this.placesService,
			answerFormatter: this.intentInterpreter,
			getCurrentImageDataUrl: this.getCurrentImageDataUrl.bind(this),
			onInfo: this.handleTourInfo.bind(this),
			onError: this.handleTourError.bind(this),
			speak: true
		});
		this.orchestrator = new JourneyOrchestrator({
			hyperlapse: this.hyperlapse,
			geocoder: this.geocoder,
			tourGuide: this.tourGuide,
			intentInterpreter: this.intentInterpreter,
			onStatus: this.setStatus.bind(this),
			onStateChange: this.handleStateChange.bind(this),
			onLookChange: this.handleLookChange.bind(this),
			onTourInfo: this.handleTourInfo.bind(this),
			onPlan: this.runPlan.bind(this),
			onRoute: this.handleRoute.bind(this)
		});

		this.bindHyperlapse();
		this.bindControls();
		this.bindVoice();
		this.setupResponsiveViewer();
		this.resetControls();
	}

	DemoRouteApp.prototype.setStatus = function(message) {
		byId("status").textContent = message || "";
	};

	DemoRouteApp.prototype.handleStateChange = function(event) {
		byId("route-state").textContent = event.state;
	};

	DemoRouteApp.prototype.handleTourInfo = function(event) {
		this.setTourInfo(event.text);
	};

	DemoRouteApp.prototype.handleTourError = function(event) {
		this.setTourInfo(event.message);
	};

	DemoRouteApp.prototype.handleLookChange = function() {
		this.updateLookReadout();
		if (this.tourGuide.invalidateContext) {
			this.tourGuide.invalidateContext();
		}
		this.tourGuide.prefetchCurrentView({ force: true });
	};

	DemoRouteApp.prototype.setTourInfo = function(message) {
		byId("tour-info").textContent = message || "";
	};

	DemoRouteApp.prototype.updateMapTilesQuotaStatus = function(state) {
		var element = byId("quota-state");
		var message;

		if (!element || !state) return;
		if (state.likelyDailyQuotaExhausted) {
			message = "Map Tiles quota warning: Street View Tiles requests are returning 429. The daily Map Tiles quota is likely exhausted for " + state.date + ". Using Street View Static fallback imagery where available.";
		} else if (state.tileRequests) {
			message = "Map Tiles today: " + state.tileRequests + " tile requests, " + state.tile429s + " throttled, " + state.staticFallbacks + " static fallbacks.";
		} else {
			message = "";
		}
		element.textContent = message;
	};

	DemoRouteApp.prototype.updateImagerySourceStatus = function() {
		var element = byId("source-state");
		var mode = byId("streetview-source") ? byId("streetview-source").value : "auto";
		var length = this.hyperlapse && this.hyperlapse.length ? this.hyperlapse.length() : 0;
		var staticOnly = 0;
		var staticFallbacks = 0;
		var placeholders = 0;
		var point;
		var i;
		var message;

		if (!element) return;
		for (i = 0; i < length; i++) {
			point = this.hyperlapse.getPointAt ? this.hyperlapse.getPointAt(i) : null;
			if (!point) continue;
			if (point.staticOnly) staticOnly++;
			if (point.staticFallback) staticFallbacks++;
			if (point.placeholder) placeholders++;
		}
		if (mode === "static") {
			message = "Imagery source: Street View Static only. Map Tiles tile quota is not used for frame imagery.";
		} else if (mode === "tiles") {
			message = "Imagery source: Map Tiles only. Static fallback is disabled, so exhausted tile quota can produce unavailable frames.";
		} else {
			message = "Imagery source: Auto. Uses Map Tiles first, then Street View Static when tile imagery is unavailable.";
		}
		if (staticFallbacks || staticOnly || placeholders) {
			message += " Loaded: " + staticOnly + " static-only, " + staticFallbacks + " static fallback, " + placeholders + " unavailable.";
		}
		element.textContent = message;
	};

	DemoRouteApp.prototype.setPlayerOverlay = function(state, message) {
		var overlay = byId("player-overlay");
		var button = byId("player-toggle");
		var icon = button && button.querySelector(".player-icon");
		var label = byId("player-overlay-label");
		var disabled = state === "loading" || state === "error" || !this.hyperlapse.length();

		if (!overlay || !button || !label) return;
		overlay.setAttribute("data-state", state);
		label.textContent = message || "";
		button.disabled = disabled;
		if (state === "playing") {
			button.setAttribute("aria-label", "Pause hyperlapse");
			if (icon) icon.textContent = "Ⅱ";
		} else {
			button.setAttribute("aria-label", "Play hyperlapse");
			if (icon) icon.textContent = "▶";
		}
		this.updateDownloadAvailability();
	};

	DemoRouteApp.prototype.togglePlayer = function() {
		if (!this.hyperlapse.length() || this.hyperlapse.isLoading()) return;
		if (this.hyperlapse.isPlaying()) {
			this.hyperlapse.pause();
		} else {
			this.hyperlapse.playForward();
		}
	};

	DemoRouteApp.prototype.updateDownloadAvailability = function() {
		var button = byId("download-video");
		var playable = this.hyperlapse && this.hyperlapse.loadedLength ? this.hyperlapse.loadedLength() : 0;

		if (!button) return;
		button.disabled = !playable || this.hyperlapse.isRecording();
		button.textContent = this.hyperlapse.isRecording() ? "Recording..." : "Download video";
	};

	DemoRouteApp.prototype.downloadVideo = function() {
		var playable = this.hyperlapse.loadedLength ? this.hyperlapse.loadedLength() : 0;
		var duration;
		var started;

		if (!playable || this.hyperlapse.isRecording()) return;
		this.pendingDownloadName = "hyperlapse-demo-route.webm";
		this.hyperlapse.seek(0);
		started = this.hyperlapse.startRecording({
			frameRate: 30,
			videoBitsPerSecond: 3000000
		});
		if (!started) {
			this.pendingDownloadName = null;
			return;
		}
		this.setStatus("Recording loaded hyperlapse frames for download...");
		this.updateDownloadAvailability();
		this.hyperlapse.playForward();
		duration = Math.max(1200, playable * this.hyperlapse.millis + 900);
		global.setTimeout(function() {
			this.hyperlapse.pause();
			this.hyperlapse.stopRecording();
		}.bind(this), duration);
	};

	DemoRouteApp.prototype.setPlayerMenuOpen = function(open) {
		var menu = byId("player-menu");
		var button = byId("player-menu-button");

		if (!menu || !button) return;
		menu.setAttribute("aria-expanded", open ? "true" : "false");
		button.setAttribute("aria-expanded", open ? "true" : "false");
		button.setAttribute("aria-label", open ? "Close player menu" : "Open player menu");
	};

	DemoRouteApp.prototype.isPlayerMenuOpen = function() {
		var menu = byId("player-menu");
		return !!(menu && menu.getAttribute("aria-expanded") === "true");
	};

	DemoRouteApp.prototype.getCurrentImageDataUrl = function() {
		var canvas = this.hyperlapse && this.hyperlapse.webgl && this.hyperlapse.webgl().domElement;
		var captureCanvas;
		var captureContext;
		var maxWidth = 512;
		var scale;
		var width;
		var height;

		if (!canvas || !canvas.toDataURL) return null;
		try {
			if (this.hyperlapse && this.hyperlapse.renderFrame) {
				this.hyperlapse.renderFrame();
			}
			scale = Math.min(1, maxWidth / Math.max(1, canvas.width || maxWidth));
			width = Math.max(1, Math.round((canvas.width || maxWidth) * scale));
			height = Math.max(1, Math.round((canvas.height || Math.round(maxWidth * 9 / 16)) * scale));
			captureCanvas = document.createElement("canvas");
			captureCanvas.width = width;
			captureCanvas.height = height;
			captureContext = captureCanvas.getContext("2d");
			captureContext.drawImage(canvas, 0, 0, width, height);
			return captureCanvas.toDataURL("image/jpeg", 0.55);
		} catch(e) {
			return null;
		}
	};

	DemoRouteApp.prototype.ensureRouteMap = function(center) {
		if (!this.mapElement) return;
		if (!this.routeMap) {
			this.routeMap = new google.maps.Map(this.mapElement, {
				center: center || { lat: 53.347875, lng: -6.228956 },
				zoom: 14,
				mapTypeControl: false,
				streetViewControl: false,
				fullscreenControl: true
			});
			this.routeMarker = new google.maps.Marker({
				map: this.routeMap,
				position: center || { lat: 53.347875, lng: -6.228956 },
				title: "Current Hyperlapse position"
			});
		}
	};

	DemoRouteApp.prototype.handleRoute = function(event) {
		var route = event && event.route && event.route.routes && event.route.routes[0];
		var path = route && route.overview_path;
		var bounds;

		if (!path || !path.length) return;
		this.ensureRouteMap(path[0]);
		if (!this.routeMap) return;
		if (this.routePolyline) {
			this.routePolyline.setMap(null);
		}
		this.routePolyline = new google.maps.Polyline({
			map: this.routeMap,
			path: path,
			strokeColor: "#0b57d0",
			strokeOpacity: 0.9,
			strokeWeight: 5
		});
		if (this.routeClickListener) {
			google.maps.event.removeListener(this.routeClickListener);
		}
		this.routeClickListener = this.routePolyline.addListener("click", function(mapEvent) {
			this.seekToClosestFrame(mapEvent.latLng);
		}.bind(this));
		bounds = new google.maps.LatLngBounds();
		path.forEach(function(point) { bounds.extend(point); });
		this.routeMap.fitBounds(bounds);
		this.updateRouteMarker({ point: { location: path[0] } });
	};

	DemoRouteApp.prototype.seekToClosestFrame = function(location) {
		var bestIndex = -1;
		var bestDistance = Number.MAX_VALUE;
		var i;
		var point;
		var distance;

		if (!location || !this.hyperlapse.length() || !google.maps.geometry || !google.maps.geometry.spherical) return false;
		for (i = 0; i < this.hyperlapse.length(); i++) {
			point = this.hyperlapse.getPointAt ? this.hyperlapse.getPointAt(i) : null;
			if (!point || !point.location) continue;
			distance = google.maps.geometry.spherical.computeDistanceBetween(location, point.location);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestIndex = i;
			}
		}
		if (bestIndex === -1) return false;
		this.seekTo(bestIndex, { clearGuide: false });
		this.updateTimeline(bestIndex);
		return true;
	};

	DemoRouteApp.prototype.updateRouteMarker = function(event) {
		var point = event && event.point;
		var location = point && point.location;

		if (!location) return;
		this.ensureRouteMap(location);
		if (!this.routeMarker) return;
		this.routeMarker.setPosition(location);
		if (this.routeMap) {
			this.routeMap.panTo(location);
		}
	};

	DemoRouteApp.prototype.getModeDefaults = function(mode) {
		if (mode === "WALKING") {
			return { millis: 1400, distance_between_points: 2, max_points: 160, speedMetersPerSecond: 1.4 };
		}
		if (mode === "BICYCLING") {
			return { millis: 800, distance_between_points: 4, max_points: 150, speedMetersPerSecond: 5 };
		}
		return { millis: 560, distance_between_points: 6, max_points: 120, speedMetersPerSecond: 11 };
	};

	DemoRouteApp.prototype.getQualityDefaults = function(mode, quality) {
		if (quality === "cinematic") {
			if (mode === "WALKING") return { distance_between_points: 0.75, max_points: 500 };
			if (mode === "BICYCLING") return { distance_between_points: 1.5, max_points: 500 };
			return { distance_between_points: 2, max_points: 450 };
		}
		if (quality === "low") {
			if (mode === "WALKING") return { distance_between_points: 5, max_points: 90 };
			if (mode === "BICYCLING") return { distance_between_points: 10, max_points: 90 };
			return { distance_between_points: 18, max_points: 80 };
		}
		var defaults = this.getModeDefaults(mode);
		return {
			distance_between_points: defaults.distance_between_points,
			max_points: defaults.max_points
		};
	};

	DemoRouteApp.prototype.updateSpeedLabel = function() {
		byId("speed-value").textContent = Number(byId("speed").value).toFixed(2) + "x";
	};

	DemoRouteApp.prototype.updateSamplingLabel = function() {
		byId("distance-between-points-value").textContent = Number(byId("distance-between-points").value).toFixed(1) + " m";
	};

	DemoRouteApp.prototype.setRouteSettingsDirty = function(message) {
		this.routeSettingsDirty = true;
		byId("apply-route-settings").disabled = false;
		byId("route-settings-state").textContent = message || "Route settings changed. Apply them to regenerate the route.";
	};

	DemoRouteApp.prototype.clearRouteSettingsDirty = function() {
		this.routeSettingsDirty = false;
		byId("apply-route-settings").disabled = true;
		byId("route-settings-state").textContent = "Route settings applied.";
	};

	DemoRouteApp.prototype.setRouteControlsEnabled = function(enabled) {
		["timeline", "play", "reverse", "next", "prev"].forEach(function(id) {
			var element = byId(id);
			if (element) element.disabled = !enabled;
		});
		if (enabled && !this.routeSettingsDirty) {
			byId("apply-route-settings").disabled = true;
		}
		if (enabled) {
			this.configureTimeline();
		} else {
			byId("timeline").disabled = true;
		}
	};

	DemoRouteApp.prototype.applySpeed = function() {
		var multiplier = Number(byId("speed").value) || 1;
		this.hyperlapse.millis = Math.max(60, Math.round(this.playbackBaseMillis / multiplier));
		this.updateSpeedLabel();
	};

	DemoRouteApp.prototype.updateTimeline = function(position) {
		var timeline = byId("timeline");
		var playable = this.hyperlapse.loadedLength ? this.hyperlapse.loadedLength() : this.hyperlapse.length();
		var max = Math.max(0, playable - 1);

		timeline.max = max;
		if (!this.seeking) {
			timeline.value = Math.max(0, Math.min(max, position || 0));
		}
		byId("frame-readout").textContent = playable ? (Number(timeline.value) + 1) + " / " + playable + (playable < this.hyperlapse.length() ? " loaded of " + this.hyperlapse.length() : "") : "0 / 0";
	};

	DemoRouteApp.prototype.configureTimeline = function() {
		var playable = this.hyperlapse.loadedLength ? this.hyperlapse.loadedLength() : this.hyperlapse.length();
		byId("timeline").disabled = playable === 0;
		this.updateTimeline(this.hyperlapse.getPosition());
	};

	DemoRouteApp.prototype.seekTo = function(value, options) {
		options = options || {};
		if (!this.hyperlapse.length()) return;
		this.hyperlapse.seek(Number(value));
		if (options.clearGuide !== false) {
			this.setTourInfo("");
		}
	};

	DemoRouteApp.prototype.updateModeWarning = function(mode) {
		byId("mode-warning").textContent =
			(mode === "WALKING" || mode === "BICYCLING") ?
			"Walking and bicycling routes are beta and may miss some sidewalks, pedestrian paths, or cycling paths." :
			"";
	};

	DemoRouteApp.prototype.applyViewMode = function(mode) {
		this.hyperlapse.follow_route = mode === "follow";
		this.hyperlapse.use_lookat = mode === "lookat";
	};

	DemoRouteApp.prototype.updateLookReadout = function() {
		byId("look-readout").textContent = Math.round(this.hyperlapse.position.x) + "deg, " + Math.round(this.hyperlapse.position.y) + "deg";
	};

	DemoRouteApp.prototype.setFreeLook = function(deltaX, deltaY) {
		this.hyperlapse.follow_route = false;
		this.hyperlapse.use_lookat = false;
		byId("view-mode").value = "free";
		this.hyperlapse.nudgeLook(deltaX, deltaY);
	};

	DemoRouteApp.prototype.applyPlanToControls = function(plan) {
		if (!plan) return;
		if (plan.prompt) byId("prompt").value = plan.prompt;
		if (plan.travelMode) byId("travel-mode").value = plan.travelMode;
		if (plan.viewMode) byId("view-mode").value = plan.viewMode;
		if (plan.motionQuality) byId("motion-quality").value = plan.motionQuality;
		if (plan.distance_between_points) byId("distance-between-points").value = Number(plan.distance_between_points);
		if (plan.streetViewTileZoom || plan.streetViewTileZoom === 0) byId("tile-quality").value = String(plan.streetViewTileZoom);
		if (plan.streetViewSourceMode) byId("streetview-source").value = plan.streetViewSourceMode;
		if (plan.millis) {
			this.playbackBaseMillis = Number(plan.millis);
			byId("speed").value = 1;
		}
	};

	DemoRouteApp.prototype.planFromControls = function(plan) {
		var next = Object.assign({}, plan || {});
		var mode = byId("travel-mode").value;
		var quality = byId("motion-quality").value;
		var defaults = this.getModeDefaults(mode);
		var qualityDefaults = this.getQualityDefaults(mode, quality);

		next.travelMode = mode;
		next.viewMode = byId("view-mode").value;
		next.motionQuality = quality;
		next.distance_between_points = Number(byId("distance-between-points").value) || qualityDefaults.distance_between_points;
		next.max_points = next.max_points || qualityDefaults.max_points;
		next.speedMetersPerSecond = next.speedMetersPerSecond || defaults.speedMetersPerSecond;
		next.streetViewTileZoom = Number(byId("tile-quality").value);
		next.streetViewSourceMode = byId("streetview-source").value;
		next.prompt = byId("prompt").value || next.prompt;
		return next;
	};

	DemoRouteApp.prototype.runPlan = function(plan) {
		plan = this.planFromControls(plan);

		this.activeCameraCues = plan.cameraCues || [];
		this.currentPlan = plan;
		this.hyperlapse.setDistanceBetweenPoint(plan.distance_between_points);
		this.hyperlapse.setTileZoom(plan.streetViewTileZoom);
		this.hyperlapse.setStreetViewSourceMode(plan.streetViewSourceMode);
		this.updateImagerySourceStatus();
		this.updateSamplingLabel();
		this.applySpeed();
		this.applyViewMode(plan.viewMode);
		this.updateModeWarning(plan.travelMode);
		this.clearRouteSettingsDirty();
		this.orchestrator.executePlan(plan);
	};

	DemoRouteApp.prototype.runPromptPlan = function() {
		var prompt = byId("prompt").value;
		var fallbackPlan = this.planFromControls(this.orchestrator.buildPlanFromPrompt(prompt));

		if (this.orchestrator && this.orchestrator.handleOperatorText) {
			this.orchestrator.handleOperatorText(prompt, {
				type: "create_plan",
				direction: null,
				pause: false,
				locationText: null,
				placeQuery: null,
				answerStyle: "tourist",
				plan: fallbackPlan,
				raw: prompt
			});
			return;
		}
		this.runPlan(fallbackPlan);
	};

	DemoRouteApp.prototype.applyRouteSettings = function() {
		if (this.currentPlan) {
			this.runPlan(this.currentPlan);
		} else {
			this.runPromptPlan();
		}
	};

	DemoRouteApp.prototype.resetControls = function() {
		var currentDefaults = this.getModeDefaults(byId("travel-mode").value);
		this.playbackBaseMillis = currentDefaults.millis;
		byId("speed").value = 1;
		this.applySpeed();
		this.updateSamplingLabel();
		this.updateLookReadout();
		this.configureTimeline();
		this.applyViewMode(byId("view-mode").value);
		this.updateModeWarning(byId("travel-mode").value);
		this.updateImagerySourceStatus();
		this.clearRouteSettingsDirty();
	};

	DemoRouteApp.prototype.bindHyperlapse = function() {
		this.hyperlapse.addEventListener("error", function(event) {
			this.setStatus("Error: " + event.message);
			this.setPlayerOverlay("error", event.message);
		}.bind(this));

		this.hyperlapse.addEventListener("frame", function(event) {
			this.updateTimeline(event.position);
			this.updateRouteMarker(event);
			this.applyCameraCue(event);
			this.tourGuide.prefetchCurrentView();
			this.updateDownloadAvailability();
		}.bind(this));

		this.hyperlapse.addEventListener("seek", function(event) {
			this.updateRouteMarker(event);
			if (this.tourGuide.invalidateContext) {
				this.tourGuide.invalidateContext();
			}
			this.tourGuide.prefetchCurrentView({ force: true });
		}.bind(this));

		this.hyperlapse.addEventListener("lookchange", function() {
			this.updateLookReadout();
			if (this.tourGuide.invalidateContext) {
				this.tourGuide.invalidateContext();
			}
			this.tourGuide.prefetchCurrentView({ force: true });
		}.bind(this));

		this.hyperlapse.addEventListener("routeprogress", function() {
			this.setRouteControlsEnabled(false);
			this.setStatus("Resolving Street View route points...");
			this.setPlayerOverlay("loading", "Resolving Street View route points...");
		}.bind(this));

		this.hyperlapse.addEventListener("routecomplete", function() {
			this.setStatus("Route ready. Preloading panorama frames...");
			this.setPlayerOverlay("loading", "Preloading panorama frames...");
			this.hyperlapse.load();
		}.bind(this));

		this.hyperlapse.addEventListener("loadready", function(event) {
			this.setRouteControlsEnabled(true);
			this.setStatus("Ready. Click play to start while the remaining frames continue loading.");
			this.configureTimeline();
			this.setPlayerOverlay("ready", "Ready. Click play to start.");
			this.updateDownloadAvailability();
		}.bind(this));

		this.hyperlapse.addEventListener("loadprogress", function(event) {
			var playable = this.hyperlapse.loadedLength ? this.hyperlapse.loadedLength() : 0;
			this.setStatus("Loading frame " + event.position + " of " + this.hyperlapse.length() + (playable ? " (" + playable + " playable)." : "..."));
			if (!playable) {
				this.setPlayerOverlay("loading", "Loading frame " + event.position + " of " + this.hyperlapse.length() + "...");
			}
			this.configureTimeline();
			this.updateDownloadAvailability();
		}.bind(this));

		this.hyperlapse.addEventListener("loadwarning", function(event) {
			this.setStatus((event && event.message ? event.message : "A Street View frame is temporarily unavailable.") + " Continuing with a placeholder frame.");
		}.bind(this));

		this.hyperlapse.addEventListener("maptilesquota", function(event) {
			this.updateMapTilesQuotaStatus(event.state);
		}.bind(this));

		this.hyperlapse.addEventListener("loadcomplete", function() {
			this.reloadingTiles = false;
			this.setRouteControlsEnabled(true);
			this.setStatus("Ready. Click play to start the demo route.");
			this.configureTimeline();
			if (!this.hyperlapse.isPlaying()) {
				this.setPlayerOverlay("ready", "Ready. Click play to start.");
			}
			this.updateDownloadAvailability();
		}.bind(this));

		this.hyperlapse.addEventListener("play", function() {
			this.setPlayerOverlay("playing", "Playing");
		}.bind(this));

		this.hyperlapse.addEventListener("pause", function() {
			var playable = this.hyperlapse.loadedLength ? this.hyperlapse.loadedLength() : this.hyperlapse.length();
			this.setPlayerOverlay(playable ? "paused" : "loading", playable ? "Paused" : "Loading route...");
		}.bind(this));

		this.hyperlapse.addEventListener("recordstart", function() {
			this.updateDownloadAvailability();
		}.bind(this));

		this.hyperlapse.addEventListener("recordcomplete", function() {
			var filename = this.pendingDownloadName;
			this.pendingDownloadName = null;
			if (filename) {
				this.hyperlapse.downloadRecording(filename);
				this.setStatus("Video downloaded.");
			}
			this.updateDownloadAvailability();
		}.bind(this));
	};

	DemoRouteApp.prototype.applyCameraCue = function(event) {
		var cue = null;
		var progress;
		var i;

		if (!this.activeCameraCues.length || !event || typeof event.position === "undefined" || !this.hyperlapse.length()) {
			return;
		}

		progress = event.position / Math.max(1, this.hyperlapse.length() - 1);
		for (i = 0; i < this.activeCameraCues.length; i++) {
			if (progress >= this.activeCameraCues[i].from && progress <= this.activeCameraCues[i].to) {
				cue = this.activeCameraCues[i];
				break;
			}
		}

		if (cue && cue.lookat && byId("view-mode").value === "lookat") {
			this.hyperlapse.follow_route = false;
			this.hyperlapse.use_lookat = true;
			this.hyperlapse.setLookat(asLatLng(cue.lookat));
		}
	};

	DemoRouteApp.prototype.bindControls = function() {
		var playerMenu = byId("player-menu");
		var playerMenuButton = byId("player-menu-button");

		byId("play").onclick = function() { this.hyperlapse.playForward(); }.bind(this);
		byId("reverse").onclick = function() { this.hyperlapse.playReverse(); }.bind(this);
		byId("pause").onclick = function() { this.hyperlapse.pause(); }.bind(this);
		byId("player-toggle").onclick = function() { this.togglePlayer(); }.bind(this);
		playerMenuButton.onclick = function(event) {
			event.stopPropagation();
			this.setPlayerMenuOpen(!this.isPlayerMenuOpen());
		}.bind(this);
		byId("download-video").onclick = function() {
			this.setPlayerMenuOpen(false);
			this.downloadVideo();
		}.bind(this);
		byId("next").onclick = function() { this.hyperlapse.next(); }.bind(this);
		byId("prev").onclick = function() { this.hyperlapse.prev(); }.bind(this);
		byId("run-prompt").onclick = function() { this.runPromptPlan(); }.bind(this);
		byId("apply-route-settings").onclick = function() { this.applyRouteSettings(); }.bind(this);
		byId("reset-look").onclick = function() { this.hyperlapse.resetLook(); }.bind(this);
		byId("look-left").onclick = function() { this.setFreeLook(-20, 0); }.bind(this);
		byId("look-right").onclick = function() { this.setFreeLook(20, 0); }.bind(this);
		byId("look-up").onclick = function() { this.setFreeLook(0, -12); }.bind(this);
		byId("look-down").onclick = function() { this.setFreeLook(0, 12); }.bind(this);
		byId("voice-start").onclick = function() { this.voice.start(); }.bind(this);
		byId("voice-stop").onclick = function() { this.voice.stop(); }.bind(this);

		document.addEventListener("click", function(event) {
			if (!this.isPlayerMenuOpen() || (playerMenu && playerMenu.contains(event.target))) return;
			this.setPlayerMenuOpen(false);
		}.bind(this));

		document.addEventListener("keydown", function(event) {
			if (event.key === "Escape" && this.isPlayerMenuOpen()) {
				this.setPlayerMenuOpen(false);
				playerMenuButton.focus();
			}
		}.bind(this));

		byId("travel-mode").onchange = function(event) {
			var defaults = this.getModeDefaults(event.target.value);
			this.playbackBaseMillis = defaults.millis;
			byId("speed").value = 1;
			this.applySpeed();
			this.updateModeWarning(event.target.value);
			this.setRouteSettingsDirty("Travel mode changed. Apply route settings to request a new " + event.target.options[event.target.selectedIndex].text.toLowerCase() + " route.");
		}.bind(this);

		byId("view-mode").onchange = function(event) {
			this.applyViewMode(event.target.value);
		}.bind(this);

		byId("motion-quality").onchange = function(event) {
			var mode = byId("travel-mode").value;
			var qualityDefaults = this.getQualityDefaults(mode, event.target.value);
			byId("distance-between-points").value = qualityDefaults.distance_between_points;
			this.updateSamplingLabel();
			this.hyperlapse.setDistanceBetweenPoint(qualityDefaults.distance_between_points);
			this.hyperlapse.setMaxPoints(qualityDefaults.max_points);
			this.setRouteSettingsDirty("Motion quality changed. Apply route settings to regenerate sampled frames.");
		}.bind(this);

		byId("speed").oninput = this.applySpeed.bind(this);

		byId("distance-between-points").oninput = function(event) {
			this.updateSamplingLabel();
			this.hyperlapse.setDistanceBetweenPoint(Number(event.target.value));
			this.setRouteSettingsDirty("Point spacing changed. Apply route settings to regenerate route frames at this spacing.");
		}.bind(this);

		byId("tile-quality").onchange = function(event) {
			this.hyperlapse.setTileZoom(Number(event.target.value));
			if (this.hyperlapse.length()) {
				this.reloadingTiles = true;
				this.setRouteControlsEnabled(false);
				this.setStatus("Reloading Street View frames at the selected tile quality...");
				this.hyperlapse.load();
			}
		}.bind(this);

		byId("timeline").oninput = function(event) {
			this.seeking = true;
			this.seekTo(event.target.value);
			this.updateTimeline(Number(event.target.value));
		}.bind(this);

		byId("timeline").onchange = function(event) {
			this.seeking = false;
			this.seekTo(event.target.value, { clearGuide: false });
			this.updateTimeline(this.hyperlapse.getPosition());
		}.bind(this);

		byId("guide-form").onsubmit = function(event) {
			var input = byId("guide-prompt");
			var text = input.value.trim();
			event.preventDefault();
			if (!text) return;
			byId("transcript").textContent = text;
			byId("voice-action").textContent = "typed_prompt";
			this.orchestrator.handleGuidePrompt(text);
			input.value = "";
		}.bind(this);

		this.bindPointerLook();
	};

	DemoRouteApp.prototype.bindPointerLook = function() {
		var dragging = false;
		var startX = 0;
		var startY = 0;
		var baseX = 0;
		var baseY = 0;

		this.pano.addEventListener("pointerdown", function(event) {
			dragging = true;
			startX = event.clientX;
			startY = event.clientY;
			baseX = this.hyperlapse.position.x;
			baseY = this.hyperlapse.position.y;
			this.pano.setPointerCapture(event.pointerId);
		}.bind(this));

		this.pano.addEventListener("pointermove", function(event) {
			if (!dragging) return;
			this.hyperlapse.follow_route = false;
			this.hyperlapse.use_lookat = false;
			byId("view-mode").value = "free";
			this.hyperlapse.setLookOffset(
				baseX - ((event.clientX - startX) * this.hyperlapse.fov() / 500),
				baseY + ((event.clientY - startY) * this.hyperlapse.fov() / 500)
			);
		}.bind(this));

		this.pano.addEventListener("pointerup", function(event) {
			dragging = false;
			this.pano.releasePointerCapture(event.pointerId);
		}.bind(this));

		this.pano.addEventListener("keydown", function(event) {
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				this.setFreeLook(-10, 0);
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				this.setFreeLook(10, 0);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				this.setFreeLook(0, -8);
			} else if (event.key === "ArrowDown") {
				event.preventDefault();
				this.setFreeLook(0, 8);
			} else if (event.key === "Home") {
				event.preventDefault();
				this.hyperlapse.resetLook();
			} else if (event.key === " ") {
				event.preventDefault();
				if (this.hyperlapse.isPlaying()) {
					this.hyperlapse.pause();
				} else {
					this.hyperlapse.playForward();
				}
			}
		}.bind(this));
	};

	DemoRouteApp.prototype.bindVoice = function() {
		this.voice.onState = function(event) {
			byId("voice-state").textContent = event.listening ? "Listening..." : "Idle";
		};
		this.voice.onTranscript = function(event) {
			byId("transcript").textContent = event.text;
		};
		this.voice.onError = function(event) {
			this.setStatus("Voice error: " + event.message);
		}.bind(this);
		this.voice.onCommand = function(command) {
			byId("voice-action").textContent = command.type + (command.direction ? " " + command.direction : "");
			this.orchestrator.handleOperatorText(command.raw, command);
		}.bind(this);
	};

	DemoRouteApp.prototype.setupResponsiveViewer = function() {
		var resize = function() {
			var width = Math.max(320, Math.round(this.pano.clientWidth || 960));
			var height = Math.max(180, Math.round(this.pano.clientHeight || width * 9 / 16));
			this.hyperlapse.setSize(width, height);
		}.bind(this);

		if (global.ResizeObserver) {
			this.resizeObserver = new ResizeObserver(resize);
			this.resizeObserver.observe(this.pano);
		}
		global.addEventListener("resize", resize);
		if (global.visualViewport) {
			global.visualViewport.addEventListener("resize", resize);
		}
		resize();
	};

	DemoRouteApp.prototype.load = function(plan) {
		if (this.hyperlapse && this.hyperlapse.getMapTilesQuota) {
			this.updateMapTilesQuotaStatus(this.hyperlapse.getMapTilesQuota());
		}
		if (plan) {
			this.applyPlanToControls(plan);
			this.updateSpeedLabel();
			this.runPlan(plan);
		} else {
			this.runPromptPlan();
		}
	};

	global.DemoRouteApp = DemoRouteApp;
})(window);
