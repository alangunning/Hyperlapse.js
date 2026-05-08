(function(global) {
	function toLatLng(point) {
		if (!point) return null;
		if (typeof point.lat === "function") return new google.maps.LatLng(point.lat(), point.lng());
		return new google.maps.LatLng(point.lat, point.lng);
	}

	function estimateDistance(path) {
		var total = 0;

		for (var i = 1; i < path.length; i++) {
			total += google.maps.geometry.spherical.computeDistanceBetween(path[i - 1], path[i]);
		}

		return total;
	}

	function toIntermediate(waypoint) {
		return {
			location: waypoint.location,
			via: waypoint.stopover === false
		};
	}

	function normalizeTravelMode(mode) {
		var value = (mode || "DRIVING").toUpperCase();

		if (value === "DRIVE") return "DRIVING";
		if (value === "BICYCLE") return "BICYCLING";
		if (value === "WALK") return "WALKING";
		return value;
	}

	global.GoogleRoutesAdapter = {
		computeRoute: function(request) {
			var routesLibraryRef;
			var compute = function(waypoints) {
				return routesLibraryRef.Route.computeRoutes({
					origin: request.origin,
					destination: request.destination,
					intermediates: (waypoints || []).map(toIntermediate),
					travelMode: normalizeTravelMode(request.travelMode),
					fields: ["path", "distanceMeters", "viewport"]
				});
			};
			var normalizeResponse = function(response) {
				var route = response.routes && response.routes[0];
				var path;

				if (!route || !route.path || !route.path.length) {
					throw new Error("No route found.");
				}

				path = route.path.map(toLatLng);

				return {
					request: request,
					routes: [{
						overview_path: path,
						legs: [{
							distance: {
								value: route.distanceMeters || estimateDistance(path)
							}
						}],
						bounds: route.viewport || null,
						routeObject: route
					}]
				};
			};

			return google.maps.importLibrary("routes").then(function(routesLibrary) {
				routesLibraryRef = routesLibrary;
				return compute(request.waypoints || []);
			}).then(function(response) {
				return normalizeResponse(response);
			}).catch(function(error) {
				if ((request.waypoints || []).length && error.message === "No route found.") {
					return compute([]).then(normalizeResponse);
				}
				throw error;
			}).then(function(response) {
				return response;
			});
		}
	};
})(window);
