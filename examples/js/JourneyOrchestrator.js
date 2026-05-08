(function(global) {
	function JourneyOrchestrator(options) {
		options = options || {};
		this.hyperlapse = options.hyperlapse;
		this.directionsService = options.directionsService;
		this.geocoder = options.geocoder;
		this.onStatus = options.onStatus || function() {};
		this.onStateChange = options.onStateChange || function() {};
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
			travelMode: google.maps.DirectionsTravelMode.DRIVING,
			max_points: 120,
			distance_between_points: 6,
			prompt: prompt
		};

		if (text.indexOf("smithfield") !== -1) {
			dublinDefault.destination = { lat: 53.349385, lng: -6.278584 };
		}
		if (text.indexOf("docklands") !== -1) {
			dublinDefault.destination = { lat: 53.349805, lng: -6.243191 };
		}

		return dublinDefault;
	};

	JourneyOrchestrator.prototype.executePlan = function(plan, callback) {
		var request = {
			origin: new google.maps.LatLng(plan.origin.lat, plan.origin.lng),
			destination: new google.maps.LatLng(plan.destination.lat, plan.destination.lng),
			waypoints: (plan.waypoints || []).map(function(w) {
				return { location: new google.maps.LatLng(w.lat, w.lng), stopover: false };
			}),
			travelMode: plan.travelMode || google.maps.DirectionsTravelMode.DRIVING
		};
		var self = this;

		this.currentPlan = plan;
		this.setState("PLANNED");
		this.onStatus("Requesting route from Directions API...");

		this.directionsService.route(request, function(response, status) {
			if (status === google.maps.DirectionsStatus.OK) {
				self.setState("RUNNING");
				self.onStatus("Route planned. Generating Street View sequence...");
				self.hyperlapse.generate({
					route: response,
					max_points: plan.max_points || 120,
					distance_between_points: plan.distance_between_points || 6
				});
				if (callback) callback(null, response);
			} else {
				self.setState("ERROR");
				self.onStatus("Route request failed: " + status);
				if (callback) callback(new Error(status));
			}
		});
	};

	JourneyOrchestrator.prototype.rerouteToText = function(locationText) {
		var self = this;
		this.onStatus("Resolving alternate location: " + locationText);
		this.geocoder.geocode({ address: locationText + ", Dublin" }, function(results, geoStatus) {
			if (geoStatus === google.maps.GeocoderStatus.OK && results[0]) {
				var currentPoint = self.hyperlapse.getCurrentPoint();
				var origin = currentPoint ? currentPoint.location : new google.maps.LatLng(53.347875, -6.228956);
				var request = {
					origin: origin,
					destination: results[0].geometry.location,
					travelMode: google.maps.DirectionsTravelMode.DRIVING
				};
				self.setState("REJOINING");
				self.directionsService.route(request, function(response, status) {
					if (status === google.maps.DirectionsStatus.OK) {
						self.onStatus("Alternate route ready. Regenerating sequence...");
						self.hyperlapse.generate({ route: response, max_points: 100, distance_between_points: 6 });
						self.setState("RUNNING");
					} else {
						self.setState("ERROR");
						self.onStatus("Reroute failed: " + status);
					}
				});
			} else {
				self.setState("ERROR");
				self.onStatus("Could not resolve location from voice input.");
			}
		});
	};

	JourneyOrchestrator.prototype.handleVoiceCommand = function(command) {
		if (!command) return;
		if (command.type === "play") this.hyperlapse.play();
		else if (command.type === "pause") this.hyperlapse.pause();
		else if (command.type === "next") this.hyperlapse.next();
		else if (command.type === "prev") this.hyperlapse.prev();
		else if (command.type === "reroute") this.rerouteToText(command.locationText);
	};

	global.JourneyOrchestrator = JourneyOrchestrator;
})(window);
