(function(global) {
	function JourneyOrchestrator(options) {
		options = options || {};
		this.hyperlapse = options.hyperlapse;
		this.geocoder = options.geocoder;
		this.tourGuide = options.tourGuide;
		this.intentInterpreter = options.intentInterpreter || null;
		this.onStatus = options.onStatus || function() {};
		this.onStateChange = options.onStateChange || function() {};
		this.onLookChange = options.onLookChange || function() {};
		this.onTourInfo = options.onTourInfo || function() {};
		this.onPlan = options.onPlan || function() {};
		this.onRoute = options.onRoute || function() {};
		this.state = "IDLE";
		this.currentPlan = null;
	}

	JourneyOrchestrator.prototype.setState = function(next) {
		this.state = next;
		this.onStateChange({ state: this.state });
	};

	JourneyOrchestrator.prototype.buildPlanFromPrompt = function(prompt) {
		var text = (prompt || "").toLowerCase();
		var dublinDefault = {
			origin: { lat: 53.347875, lng: -6.228956 }, // 3Arena
			destination: { lat: 53.343509, lng: -6.292096 }, // Heuston area
			waypoints: [{ lat: 53.349164, lng: -6.227734 }], // Gibson Hotel
			travelMode: "DRIVING",
			max_points: 120,
			distance_between_points: 6,
			speedMetersPerSecond: 11,
			motionQuality: "balanced",
			viewMode: "follow",
			prompt: prompt
		};

		if (text.indexOf("walk") !== -1 || text.indexOf("walking") !== -1 || text.indexOf("on foot") !== -1) {
			dublinDefault.travelMode = "WALKING";
			dublinDefault.max_points = 160;
			dublinDefault.distance_between_points = 2;
			dublinDefault.speedMetersPerSecond = 1.4;
		} else if (text.indexOf("cycle") !== -1 || text.indexOf("cycling") !== -1 || text.indexOf("bike") !== -1 || text.indexOf("bicycle") !== -1) {
			dublinDefault.travelMode = "BICYCLING";
			dublinDefault.max_points = 150;
			dublinDefault.distance_between_points = 4;
			dublinDefault.speedMetersPerSecond = 5;
		}

		if (text.indexOf("look at") !== -1 || text.indexOf("see ") !== -1 || text.indexOf("swing around") !== -1) {
			dublinDefault.viewMode = "lookat";
		}

		if (text.indexOf("smithfield") !== -1) {
			dublinDefault.destination = { lat: 53.349385, lng: -6.278584 };
		}
		if (text.indexOf("docklands") !== -1) {
			dublinDefault.destination = { lat: 53.349805, lng: -6.243191 };
		}

		return dublinDefault;
	};

	JourneyOrchestrator.prototype.executePlan = function(plan, callback) {
		if (this.hyperlapse && plan.waypoints && plan.waypoints[0]) {
			this.hyperlapse.setLookat(new google.maps.LatLng(plan.waypoints[0].lat, plan.waypoints[0].lng));
			this.hyperlapse.follow_route = plan.viewMode !== "lookat";
			this.hyperlapse.use_lookat = plan.viewMode === "lookat";
		}

		var request = {
			origin: new google.maps.LatLng(plan.origin.lat, plan.origin.lng),
			destination: new google.maps.LatLng(plan.destination.lat, plan.destination.lng),
			waypoints: (plan.waypoints || []).filter(function(w) {
				return w.routeVia !== false;
			}).map(function(w) {
				return { location: new google.maps.LatLng(w.lat, w.lng), stopover: false };
			}),
			travelMode: plan.travelMode || "DRIVING"
		};
		var self = this;

		this.currentPlan = plan;
		this.setState("PLANNED");
		this.onStatus("Requesting route from Routes API...");

		GoogleRoutesAdapter.computeRoute(request).then(function(response) {
			self.setState("RUNNING");
			self.onStatus("Route planned. Generating Street View sequence...");
			self.onRoute({ route: response, plan: plan });
			self.hyperlapse.generate({
				route: response,
				max_points: plan.max_points || 120,
				distance_between_points: plan.distance_between_points || 6
			});
			if (callback) callback(null, response);
		}).catch(function(error) {
			self.setState("ERROR");
			self.onStatus("Route request failed: " + error.message);
			if (callback) callback(error);
		});
	};

	JourneyOrchestrator.prototype.rerouteToText = function(locationText) {
		var self = this;
		this.onStatus("Resolving alternate location: " + locationText);
		this.geocoder.geocode({ address: locationText + ", Dublin" }, function(results, geoStatus) {
			if (geoStatus === "OK" && results[0]) {
				var currentPoint = self.hyperlapse.getCurrentPoint();
				var origin = currentPoint ? currentPoint.location : new google.maps.LatLng(53.347875, -6.228956);
				var request = {
					origin: origin,
					destination: results[0].geometry.location,
					travelMode: "DRIVING"
				};
				self.setState("REJOINING");
				GoogleRoutesAdapter.computeRoute(request).then(function(response) {
					self.onStatus("Alternate route ready. Regenerating sequence...");
					self.hyperlapse.generate({ route: response, max_points: 100, distance_between_points: 6 });
					self.setState("RUNNING");
				}).catch(function(error) {
					self.setState("ERROR");
					self.onStatus("Reroute failed: " + error.message);
				});
			} else {
				self.setState("ERROR");
				self.onStatus("Could not resolve location from voice input.");
			}
		});
	};

	JourneyOrchestrator.prototype._clamp = function(value, min, max) {
		return Math.max(min, Math.min(max, value));
	};

	JourneyOrchestrator.prototype.lookDirection = function(direction) {
		var deltaX = 0;
		var deltaY = 0;

		if (!this.hyperlapse) return;
		this.hyperlapse.follow_route = false;
		this.hyperlapse.use_lookat = false;

		if (direction === "left") deltaX = -35;
		else if (direction === "right") deltaX = 35;
		else if (direction === "up") deltaY = -18;
		else if (direction === "down") deltaY = 18;
		else if (direction === "ahead") {
			this.hyperlapse.resetLook();
		}

		if (direction !== "ahead") {
			this.hyperlapse.setLookOffset(
				this._clamp(this.hyperlapse.position.x + deltaX, -180, 180),
				this._clamp(this.hyperlapse.position.y + deltaY, -85, 85)
			);
		}

		this.onLookChange({
			x: this.hyperlapse.position.x,
			y: this.hyperlapse.position.y,
			direction: direction
		});
		this.onStatus("Looking " + direction + ".");
	};

	JourneyOrchestrator.prototype.identifyView = function(command) {
		var self = this;

		command = command || {};
		if (command.pause) this.hyperlapse.pause();
		if (command.direction) this.lookDirection(command.direction);
		if (!this.tourGuide) {
			this.onStatus("Tour guide lookup is not available.");
			return;
		}

		this.setState("IDENTIFYING");
		this.onStatus("Identifying the place in view...");
		this.tourGuide.identifyView({ direction: command.direction, query: command.placeQuery, text: command.raw || command.text || "" }, function(error, result) {
			if (error) {
				self.setState("RUNNING");
				self.onStatus("Could not identify that place: " + error.message);
				self.onTourInfo({ text: error.message, error: true });
				return;
			}
			self.setState("RUNNING");
			self.onStatus(result.candidateCount ? "Tour guide answered using " + result.candidateCount + " nearby Google Places candidates." : "Tour guide answered.");
			self.onTourInfo({ text: result.text, place: result.place });
		});
	};

	JourneyOrchestrator.prototype.listNearbyPlaces = function() {
		var self = this;

		if (!this.tourGuide) {
			this.onStatus("Tour guide lookup is not available.");
			return;
		}

		this.setState("IDENTIFYING");
		this.onStatus("Looking up nearby places...");
		this.tourGuide.listNearbyPlaces(function(error, result) {
			if (error) {
				self.setState("RUNNING");
				self.onStatus("Could not find nearby places: " + error.message);
				self.onTourInfo({ text: error.message, error: true });
				return;
			}
			self.setState("RUNNING");
			self.onStatus("Nearby places found.");
			self.onTourInfo({ text: result.text, places: result.places });
		});
	};

	JourneyOrchestrator.prototype._fallbackCommand = function(text) {
		var command;

		command = global.VoiceOrchestrator ? new global.VoiceOrchestrator().parseCommand(text) : { type: "identify_view", raw: text };
		command.raw = text;
		if (command.type === "freeform") {
			command.type = "identify_view";
		}
		return command;
	};

	JourneyOrchestrator.prototype._operatorContext = function() {
		var point = this.hyperlapse && this.hyperlapse.getCurrentPoint ? this.hyperlapse.getCurrentPoint() : null;
		var location = point && point.location;

		return {
			state: this.state,
			position: this.hyperlapse && this.hyperlapse.getPosition ? this.hyperlapse.getPosition() : 0,
			length: this.hyperlapse && this.hyperlapse.length ? this.hyperlapse.length() : 0,
			cameraHeading: this.hyperlapse && this.hyperlapse.getCameraHeading ? this.hyperlapse.getCameraHeading() : 0,
			look: this.hyperlapse ? { x: this.hyperlapse.position.x, y: this.hyperlapse.position.y } : null,
			location: location ? { lat: location.lat(), lng: location.lng() } : null,
			currentPlan: this.currentPlan
		};
	};

	JourneyOrchestrator.prototype._resolvePoint = function(value) {
		var self = this;

		return new Promise(function(resolvePoint) {
			if (!value) {
				resolvePoint(null);
				return;
			}
			if (typeof value.lat === "number" && typeof value.lng === "number") {
				resolvePoint({ lat: value.lat, lng: value.lng });
				return;
			}
			self.geocoder.geocode({ address: String(value) }, function(results, status) {
				var location;
				if (status === "OK" && results[0]) {
					location = results[0].geometry.location;
					resolvePoint({ lat: location.lat(), lng: location.lng() });
				} else {
					resolvePoint(null);
				}
			});
		});
	};

	JourneyOrchestrator.prototype._resolvePlan = function(aiPlan, prompt) {
		var fallback = this.buildPlanFromPrompt(prompt);
		var plan = aiPlan || {};
		var waypointInputs = plan.waypoints || [];
		var self = this;

		return Promise.all([
			this._resolvePoint(plan.origin || plan.originText),
			this._resolvePoint(plan.destination || plan.destinationText),
			Promise.all(waypointInputs.map(function(waypoint) {
				return self._resolvePoint(waypoint.location || waypoint.name || waypoint).then(function(point) {
					if (!point) return null;
					return {
						lat: point.lat,
						lng: point.lng,
						purpose: waypoint.purpose,
						viewHint: waypoint.viewHint,
						routeVia: waypoint.routeVia !== false
					};
				});
			})),
			Promise.all((plan.cameraCues || []).map(function(cue) {
				return self._resolvePoint(cue.lookat || cue.lookAtText).then(function(point) {
					return {
						from: cue.from,
						to: cue.to,
						label: cue.label,
						lookat: point
					};
				});
			}))
		]).then(function(results) {
			var resolved = {
				origin: results[0] || fallback.origin,
				destination: results[1] || fallback.destination,
				waypoints: results[2].filter(Boolean),
				travelMode: plan.travelMode || fallback.travelMode,
				viewMode: plan.viewMode || fallback.viewMode,
				motionQuality: plan.motionQuality || fallback.motionQuality,
				max_points: plan.max_points || fallback.max_points,
				distance_between_points: plan.distance_between_points || fallback.distance_between_points,
				speedMetersPerSecond: plan.speedMetersPerSecond || fallback.speedMetersPerSecond,
				prompt: prompt,
				cameraCues: results[3].filter(function(cue) { return cue.lookat; })
			};

			if (!resolved.waypoints.length) {
				resolved.waypoints = fallback.waypoints || [];
			}
			if (!resolved.cameraCues.length) {
				resolved.cameraCues = fallback.cameraCues || [];
			}
			return resolved;
		});
	};

	JourneyOrchestrator.prototype.handleGuidePrompt = function(text) {
		this.handleOperatorText(text);
	};

	JourneyOrchestrator.prototype.handleOperatorText = function(text, fallbackCommand) {
		var self = this;
		var fallback = fallbackCommand || this._fallbackCommand(text);

		if (!text) return;
		if (!this.intentInterpreter || !this.intentInterpreter.isAvailable()) {
			this.handleVoiceCommand(fallback);
			return;
		}

		this.setState("INTERPRETING");
		this.onStatus("Interpreting operator prompt with OpenAI...");
		this.intentInterpreter.interpret(text, this._operatorContext()).then(function(command) {
			command.raw = text;
			self.handleVoiceCommand(command);
		}).catch(function(error) {
			self.onStatus("OpenAI interpretation unavailable; using local intent fallback. " + error.message);
			self.handleVoiceCommand(fallback);
		});
	};

	JourneyOrchestrator.prototype.handleVoiceCommand = function(command) {
		var self = this;

		if (!command) return;
		if (command.type === "play") this.hyperlapse.play();
		else if (command.type === "pause") this.hyperlapse.pause();
		else if (command.type === "next") this.hyperlapse.next();
		else if (command.type === "prev") this.hyperlapse.prev();
		else if (command.type === "reroute") this.rerouteToText(command.locationText);
		else if (command.type === "look_direction") {
			if (command.pause) this.hyperlapse.pause();
			this.lookDirection(command.direction);
		}
		else if (command.type === "identify_view") this.identifyView(command);
		else if (command.type === "list_nearby_places") this.listNearbyPlaces();
		else if (command.type === "create_plan" && command.plan) {
			this.setState("PLANNING");
			this.onStatus("Resolving AI-generated route plan with Google Geocoding...");
			this._resolvePlan(command.plan, command.raw || command.plan.prompt || "").then(function(plan) {
				self.onPlan(plan);
			}).catch(function(error) {
				self.setState("ERROR");
				self.onStatus("Could not resolve AI-generated plan: " + error.message);
			});
		}
		else if (command.type === "freeform") this.identifyView(command);
	};

	global.JourneyOrchestrator = JourneyOrchestrator;
})(window);
