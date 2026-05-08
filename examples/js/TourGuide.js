(function(global) {
	function TourGuide(options) {
		options = options || {};
		this.hyperlapse = options.hyperlapse;
		this.placesService = options.placesService || null;
		this.answerFormatter = options.answerFormatter || null;
		this.getCurrentImageDataUrl = options.getCurrentImageDataUrl || null;
		this.onInfo = options.onInfo || function() {};
		this.onError = options.onError || function() {};
		this.speak = options.speak !== false;
		this.radius = options.radius || 300;
		this.directionDistance = options.directionDistance || 90;
		this.useNewPlaces = options.useNewPlaces !== false;
		this._placesLibraryPromise = null;
		this._placesLibrary = null;
		this._placesCache = {};
		this._detailsCache = {};
		this._cacheMillis = options.cacheMillis || 120000;
		this._lastPrefetchKey = null;
		this._contextVersion = 0;
	}

	TourGuide.prototype._typeLabel = function(types) {
		var labels = {
			tourist_attraction: "tourist attraction",
			museum: "museum",
			church: "church",
			establishment: "place",
			point_of_interest: "point of interest",
			convention_center: "convention centre",
			university: "university",
			lodging: "hotel",
			transit_station: "transport station",
			train_station: "train station",
			bridge: "bridge",
			arena: "arena",
			stadium: "stadium",
			event_venue: "event venue",
			performing_arts_theater: "performing arts venue",
			movie_theater: "cinema",
			historical_place: "historic place",
			cultural_landmark: "cultural landmark"
		};
		var i;

		for (i = 0; types && i < types.length; i++) {
			if (labels[types[i]]) return labels[types[i]];
		}
		return "nearby place";
	};

	TourGuide.prototype._buildSummary = function(place) {
		var bits = [];
		var typeLabel;
		var article;
		var address;

		if (!place || !place.name) {
			return "I could not identify a named place in that direction.";
		}

		typeLabel = this._typeLabel(place.types);
		article = /^[aeiou]/i.test(typeLabel) ? "an" : "a";
		address = place.vicinity || place.formatted_address;

		bits.push(place.name + " appears to be " + article + " " + typeLabel + ".");
		if (address) bits.push("It is listed near " + address + ".");
		if (place.rating) {
			bits.push("Google Places shows a rating of " + place.rating + (place.user_ratings_total ? " from " + place.user_ratings_total + " reviews." : "."));
		}
		if (place.types && place.types.indexOf("tourist_attraction") !== -1) {
			bits.push("It is marked as a tourist attraction, so it is likely worth calling out on this route.");
		}
		return bits.join(" ");
	};

	TourGuide.prototype._answerContext = function(direction) {
		var location = this._currentLocation();
		var imageDataUrl = null;
		var frameContext = this._frameContext();

		if (this.answerFormatter && this.answerFormatter.attachStreetViewImage && this.getCurrentImageDataUrl) {
			imageDataUrl = this.getCurrentImageDataUrl();
		}

		return {
			direction: direction || "ahead",
			cameraHeading: this._cameraHeading(),
			position: this.hyperlapse && this.hyperlapse.getPosition ? this.hyperlapse.getPosition() : 0,
			length: this.hyperlapse && this.hyperlapse.length ? this.hyperlapse.length() : 0,
			location: location ? { lat: location.lat(), lng: location.lng() } : null,
			frameContext: frameContext,
			imageDataUrl: imageDataUrl
		};
	};

	TourGuide.prototype._frameContext = function() {
		var index = this.hyperlapse && this.hyperlapse.getPosition ? this.hyperlapse.getPosition() : 0;
		var length = this.hyperlapse && this.hyperlapse.length ? this.hyperlapse.length() : 0;
		var frames = [];
		var offsets = [-1, 0, 1];
		var i;
		var point;

		for (i = 0; i < offsets.length; i++) {
			if (!this.hyperlapse || !this.hyperlapse.getPointAt) continue;
			point = this.hyperlapse.getPointAt(index + offsets[i]);
			if (!point || !point.location) continue;
			frames.push({
				offset: offsets[i],
				index: index + offsets[i],
				panoId: point.pano_id,
				location: { lat: point.location.lat(), lng: point.location.lng() }
			});
		}
		return {
			currentIndex: index,
			length: length,
			frames: frames
		};
	};

	TourGuide.prototype._serializePlace = function(place) {
		var location = this._placeLocation(place);
		var origin = this._currentLocation();
		var distance = null;
		var bearing = null;

		if (origin && location && google.maps.geometry && google.maps.geometry.spherical) {
			distance = Math.round(google.maps.geometry.spherical.computeDistanceBetween(origin, location));
			bearing = Math.round(google.maps.geometry.spherical.computeHeading(origin, location));
		}
		return {
			name: place && place.name,
			place_id: place && place.place_id,
			types: place && place.types,
			formatted_address: place && (place.formatted_address || place.vicinity),
			rating: place && place.rating,
			user_ratings_total: place && place.user_ratings_total,
			distanceMeters: distance,
			bearing: bearing
		};
	};

	TourGuide.prototype._deliverAnswer = function(place, direction, candidateCount, question, callback, candidates) {
		var fallbackText = this._buildSummary(place);
		var result = {
			text: fallbackText,
			place: place,
			localSelectedPlace: this._serializePlace(place),
			candidateCount: candidateCount,
			candidates: (candidates || []).slice(0, 16).map(this._serializePlace.bind(this))
		};
		var finish = function(text) {
			result.text = text || fallbackText;
			this.onInfo({ text: result.text, place: place, direction: direction || "ahead", candidateCount: candidateCount });
			this._speak(result.text);
			callback(null, result);
		}.bind(this);

		if (this.answerFormatter && this.answerFormatter.formatGuideAnswer && question) {
			this.answerFormatter.formatGuideAnswer(question, result, this._answerContext(direction)).then(finish).catch(function() {
				finish(fallbackText);
			});
			return;
		}
		finish(fallbackText);
	};

	TourGuide.prototype._extractSubject = function(text) {
		var value = (text || "").trim();
		var patterns = [
			/\b(?:i am|i'm)\s+looking\s+at\s+(?:the\s+)?([^,.?]+?)(?:\s*,?\s*(?:tell|what|who|why|where|when|give|show)\b|[,.?]|$)/i,
			/\b(?:tell me|details|information|info)\s+(?:about|on)\s+(?:the\s+)?([^,.?]+?)(?:[,.?]|$)/i,
			/\bwhat\s+(?:is|are)\s+(?:the\s+)?([^,.?]+?)(?:[,.?]|$)/i
		];
		var match;
		var subject;
		var i;

		for (i = 0; i < patterns.length; i++) {
			match = value.match(patterns[i]);
			if (match && match[1]) {
				subject = match[1].trim();
				break;
			}
		}
		if (!subject || subject.length < 3) return null;
		if (/^(that building|this building|building|place|it|that|this)$/i.test(subject)) return null;
		return subject.replace(/^(the|a|an)\s+/i, "");
	};

	TourGuide.prototype._ensurePlacesLibrary = function(callback) {
		var self = this;

		if (!this.useNewPlaces || !google.maps.importLibrary) {
			callback(null, null);
			return;
		}

		if (this._placesLibrary) {
			callback(null, this._placesLibrary);
			return;
		}

		if (!this._placesLibraryPromise) {
			this._placesLibraryPromise = google.maps.importLibrary("places").then(function(library) {
				self._placesLibrary = library;
				return library;
			});
		}

		this._placesLibraryPromise.then(function(library) {
			callback(null, library);
		}).catch(function(error) {
			callback(error);
		});
	};

	TourGuide.prototype._normalizeNewPlace = function(place) {
		var displayName = place && place.displayName;

		return {
			_newPlace: place,
			place_id: place && (place.id || place.placeId),
			name: typeof displayName === "string" ? displayName : displayName && (displayName.text || displayName.name),
			types: place && place.types,
			formatted_address: place && place.formattedAddress,
			vicinity: place && place.formattedAddress,
			rating: place && place.rating,
			user_ratings_total: place && place.userRatingCount,
			website: place && place.websiteURI,
			geometry: {
				location: place && place.location
			}
		};
	};

	TourGuide.prototype._speak = function(text) {
		if (!this.speak || !global.speechSynthesis || !text) return;
		global.speechSynthesis.cancel();
		global.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
	};

	TourGuide.prototype._currentLocation = function() {
		var currentPoint = this.hyperlapse && this.hyperlapse.getCurrentPoint ? this.hyperlapse.getCurrentPoint() : null;
		return currentPoint && currentPoint.location;
	};

	TourGuide.prototype._cameraHeading = function() {
		return this.hyperlapse && this.hyperlapse.getCameraHeading ? this.hyperlapse.getCameraHeading() : 0;
	};

	TourGuide.prototype._cacheKey = function(location, radius, suffix) {
		return [
			location.lat().toFixed(5),
			location.lng().toFixed(5),
			Math.round(radius),
			suffix || "nearby"
		].join(",");
	};

	TourGuide.prototype.invalidateContext = function() {
		this._contextVersion++;
		this._lastPrefetchKey = null;
	};

	TourGuide.prototype._angularDistance = function(a, b) {
		var diff = Math.abs((((a - b) % 360) + 540) % 360 - 180);
		return diff;
	};

	TourGuide.prototype._directionHeading = function(direction) {
		var heading = this._cameraHeading();
		if (direction === "left") return heading - 75;
		if (direction === "right") return heading + 75;
		if (direction === "behind") return heading + 180;
		return heading;
	};

	TourGuide.prototype._directionLocation = function(origin, direction) {
		if (!origin || !google.maps.geometry || !google.maps.geometry.spherical) return origin;
		return google.maps.geometry.spherical.computeOffset(origin, this.directionDistance, this._directionHeading(direction));
	};

	TourGuide.prototype._placeLocation = function(place) {
		return place && place.geometry && place.geometry.location;
	};

	TourGuide.prototype._frameLocation = function(offset) {
		var index = this.hyperlapse && this.hyperlapse.getPosition ? this.hyperlapse.getPosition() : 0;
		var point = this.hyperlapse && this.hyperlapse.getPointAt ? this.hyperlapse.getPointAt(index + offset) : null;
		return point && point.location;
	};

	TourGuide.prototype._scorePlace = function(place, origin, targetHeading, direction) {
		var placeLocation = this._placeLocation(place);
		var bearing;
		var bearingDelta;
		var distance;
		var typeBoost = 0;
		var cone = direction === "left" || direction === "right" ? 80 : 60;

		if (!placeLocation || !google.maps.geometry || !google.maps.geometry.spherical) return Number.MAX_VALUE;

		bearing = google.maps.geometry.spherical.computeHeading(origin, placeLocation);
		bearingDelta = this._angularDistance(bearing, targetHeading);
		distance = google.maps.geometry.spherical.computeDistanceBetween(origin, placeLocation);

		if (bearingDelta > cone) return Number.MAX_VALUE;
		if (place.types && place.types.indexOf("tourist_attraction") !== -1) typeBoost -= 30;
		if (place.types && place.types.indexOf("point_of_interest") !== -1) typeBoost -= 10;

		return bearingDelta * 2 + distance * 0.35 + typeBoost;
	};

	TourGuide.prototype._bestPlaceForDirection = function(places, origin, direction) {
		var targetHeading = this._directionHeading(direction);
		var best = null;
		var bestScore = Number.MAX_VALUE;
		var score;
		var i;

		for (i = 0; places && i < places.length; i++) {
			score = this._scorePlace(places[i], origin, targetHeading, direction || "ahead");
			if (score < bestScore) {
				best = places[i];
				bestScore = score;
			}
		}
		return best;
	};

	TourGuide.prototype._nearestPlace = function(places, origin, maxDistance) {
		var best = null;
		var bestDistance = Number.MAX_VALUE;
		var placeLocation;
		var distance;
		var i;

		if (!origin || !google.maps.geometry || !google.maps.geometry.spherical) return null;

		for (i = 0; places && i < places.length; i++) {
			placeLocation = this._placeLocation(places[i]);
			if (!placeLocation) continue;
			distance = google.maps.geometry.spherical.computeDistanceBetween(origin, placeLocation);
			if (distance <= maxDistance && distance < bestDistance) {
				best = places[i];
				bestDistance = distance;
			}
		}
		return best;
	};

	TourGuide.prototype._mergePlaces = function(groups) {
		var byId = {};
		var merged = [];
		var i;
		var j;
		var place;
		var key;

		for (i = 0; i < groups.length; i++) {
			for (j = 0; groups[i] && j < groups[i].length; j++) {
				place = groups[i][j];
				key = place.place_id || place.name;
				if (!key || byId[key]) continue;
				byId[key] = true;
				merged.push(place);
			}
		}
		return merged;
	};

	TourGuide.prototype._nearbyPlacesNew = function(location, callback, options) {
		var self = this;
		var radius = options.radius || this.radius;
		var collectAll = options.collectAll === true;
		var typeAttempts = [
			["convention_center", "arena", "stadium", "event_venue", "performing_arts_theater"],
			["tourist_attraction", "museum", "cultural_landmark", "historical_place", "monument"],
			["movie_theater", "auditorium"],
			["train_station", "transit_station"],
			["church"],
			["restaurant", "lodging", "store"]
		];

		this._ensurePlacesLibrary(function(libraryError, library) {
			var Place;
			var rankPreference;
			var runAttempt;

			if (libraryError || !library || !library.Place || !library.Place.searchNearby) {
				callback(libraryError || new Error("Places API (New) lookup is not available."));
				return;
			}

			Place = library.Place;
			rankPreference = library.SearchNearbyRankPreference && library.SearchNearbyRankPreference.DISTANCE;

			runAttempt = function(index) {
				var request;
				var collected = runAttempt.collected || [];

				if (index >= typeAttempts.length) {
					if (collected.length) {
						callback(null, self._mergePlaces([collected]));
					} else {
						callback(new Error("No named places found nearby."));
					}
					return;
				}

				request = {
					fields: ["id", "displayName", "location", "types", "formattedAddress", "rating", "userRatingCount"],
					locationRestriction: {
						center: location,
						radius: Math.max(radius, 250)
					},
					includedPrimaryTypes: typeAttempts[index],
					maxResultCount: 10
				};
				if (rankPreference) {
					request.rankPreference = rankPreference;
				}

				Place.searchNearby(request).then(function(response) {
					var places = (response.places || []).map(function(place) {
						return self._normalizeNewPlace(place);
					}).filter(function(place) {
						return place.name && place.geometry && place.geometry.location;
					});

					if (!places.length) {
						runAttempt(index + 1);
						return;
					}
					if (collectAll) {
						runAttempt.collected = collected.concat(places);
						runAttempt(index + 1);
						return;
					}
					callback(null, places);
				}).catch(function() {
					runAttempt(index + 1);
				});
			};

			runAttempt(0);
		});
	};

	TourGuide.prototype._nearbyPlaces = function(location, callback, options) {
		var self = this;
		var key;
		var cached;
		var attempts;
		var runAttempt;
		var radius;
		var suffix;

		if (!location) {
			callback(new Error("Places lookup is not available yet."));
			return;
		}

		options = options || {};
		radius = options.radius || this.radius;
		suffix = options.suffix || "nearby";
		key = this._cacheKey(location, radius, suffix);
		cached = this._placesCache[key];
		if (cached && Date.now() - cached.createdAt < this._cacheMillis) {
			callback(null, cached.results);
			return;
		}

		if (this.useNewPlaces) {
			this._nearbyPlacesNew(location, function(newPlacesError, newPlacesResults) {
				if (!newPlacesError && newPlacesResults && newPlacesResults.length) {
					self._placesCache[key] = {
						createdAt: Date.now(),
						results: newPlacesResults
					};
					callback(null, newPlacesResults);
					return;
				}
				if (!self.placesService) {
					callback(newPlacesError || new Error("No named places found nearby."));
					return;
				}
				runLegacy();
			}, options);
			return;
		}

		if (!this.placesService) {
			callback(new Error("Places lookup is not available yet."));
			return;
		}

		runLegacy();

		function runLegacy() {
			attempts = [
			{ location: location, radius: radius, keyword: "landmark historic building tourist attraction museum church bridge station" },
			{ location: location, radius: radius, type: "tourist_attraction" },
			{ location: location, radius: Math.max(radius, 250), type: "point_of_interest" },
			{ location: location, radius: Math.max(radius, 250) }
			];

			runAttempt = function(index) {
			if (index >= attempts.length) {
				callback(new Error("No named places found nearby."));
				return;
			}

			self.placesService.nearbySearch(attempts[index], function(results, status) {
				if (status !== google.maps.places.PlacesServiceStatus.OK || !results || !results.length) {
					runAttempt(index + 1);
					return;
				}

				self._placesCache[key] = {
					createdAt: Date.now(),
					results: results
				};
				callback(null, results);
			});
			};
			runAttempt(0);
		}
	};

	TourGuide.prototype.prefetchCurrentView = function(options) {
		options = options || {};

		var self = this;
		var origin = this._currentLocation();
		var key;
		var directions = ["ahead", "left", "right"];

		if (!origin) return;

		key = this._cacheKey(origin, this.radius, "prefetch");
		if (!options.force && key === this._lastPrefetchKey) return;
		this._lastPrefetchKey = key;

		this._nearbyPlaces(origin, function() {}, { suffix: "nearby" });
		directions.forEach(function(direction) {
			self._nearbyPlaces(self._directionLocation(origin, direction), function() {}, {
				radius: self.radius,
				suffix: direction
			});
		});
	};

	TourGuide.prototype._details = function(candidate, callback) {
		var cached;
		var detailRequest;

		if (!candidate || !candidate.place_id) {
			callback(null, candidate);
			return;
		}

		cached = this._detailsCache[candidate.place_id];
		if (cached) {
			callback(null, cached);
			return;
		}

		if (candidate._newPlace && candidate._newPlace.fetchFields) {
			candidate._newPlace.fetchFields({
				fields: ["id", "displayName", "location", "types", "formattedAddress", "rating", "userRatingCount", "websiteURI"]
			}).then(function(place) {
				var normalized = this._normalizeNewPlace(place || candidate._newPlace);
				var resolved = Object.assign({}, candidate, normalized);
				if (!resolved.name) resolved.name = candidate.name;
				if (!resolved.types) resolved.types = candidate.types;
				if (!resolved.geometry || !resolved.geometry.location) resolved.geometry = candidate.geometry;
				this._detailsCache[candidate.place_id] = resolved;
				callback(null, resolved);
			}.bind(this)).catch(function() {
				callback(null, candidate);
			});
			return;
		}

		if (!this.placesService) {
			callback(null, candidate);
			return;
		}

		detailRequest = {
			placeId: candidate.place_id,
			fields: ["name", "types", "vicinity", "formatted_address", "rating", "user_ratings_total", "website", "geometry"]
		};

		this.placesService.getDetails(detailRequest, function(place, detailsStatus) {
			var resolved = place || candidate;
			if (detailsStatus !== google.maps.places.PlacesServiceStatus.OK && !candidate) {
				callback(new Error("Place details are not available."));
				return;
			}

			if (candidate.place_id) {
				this._detailsCache[candidate.place_id] = resolved;
			}
			callback(null, resolved);
		}.bind(this));
	};

	TourGuide.prototype._findPlaceByText = function(query, callback) {
		var location = this._currentLocation();
		var request;
		var cached;
		var key;

		if (!query || !this.placesService) {
			callback(new Error("Named place search is not available."));
			return;
		}

		key = location ? this._cacheKey(location, 800, "text:" + query.toLowerCase()) : "text:" + query.toLowerCase();
		cached = this._placesCache[key];
		if (cached && Date.now() - cached.createdAt < this._cacheMillis) {
			callback(null, cached.results[0], cached.results);
			return;
		}

		request = {
			query: query + " Dublin",
			fields: ["name", "place_id", "types", "formatted_address", "geometry", "rating", "user_ratings_total"]
		};
		if (location) {
			request.location = location;
			request.radius = 1200;
		}

		this.placesService.textSearch(request, function(results, status) {
			if (status !== google.maps.places.PlacesServiceStatus.OK || !results || !results.length) {
				callback(new Error("No named place matched \"" + query + "\"."));
				return;
			}
			this._placesCache[key] = {
				createdAt: Date.now(),
				results: results
			};
			callback(null, results[0], results);
		}.bind(this));
	};

	TourGuide.prototype._searchLocation = function(direction) {
		var location = this._currentLocation();
		var heading = this.hyperlapse && this.hyperlapse.getCameraHeading ? this.hyperlapse.getCameraHeading() : 0;
		var offset = 0;

		if (!location) return null;
		if (direction === "left") offset = -70;
		else if (direction === "right") offset = 70;
		else if (direction === "behind") offset = 180;

		if (google.maps.geometry && google.maps.geometry.spherical) {
			return google.maps.geometry.spherical.computeOffset(location, 55, heading + offset);
		}
		return location;
	};

	TourGuide.prototype.identifyView = function(options, callback) {
		options = options || {};
		callback = callback || function() {};

		var self = this;
		var location = this._currentLocation();
		var contextVersion = this._contextVersion;
		var subject = options.query || this._extractSubject(options.text || "");

		if (!location) {
			callback(new Error("Places lookup is not available yet."));
			return;
		}

		if (subject) {
			this._findPlaceByText(subject, function(searchError, candidate, candidates) {
				if (searchError) {
					self.identifyView(Object.assign({}, options, { text: "", query: null }), callback);
					return;
				}
				self._details(candidate, function(detailsError, resolved) {
					if (contextVersion !== self._contextVersion) {
						callback(new Error("Place lookup was refreshed for the current frame."));
						return;
					}
					if (detailsError) {
						callback(detailsError);
						return;
					}
					self._deliverAnswer(resolved, options.direction || "named", candidates.length, options.text || subject, callback, candidates);
				});
			});
			return;
		}

		var directionLocation = this._directionLocation(location, options.direction || "ahead");

		this._nearbyPlaces(location, function(nearbyError, nearbyResults) {
			var candidate;
			var finish = function(results) {
				if (contextVersion !== self._contextVersion) {
					callback(new Error("Place lookup was refreshed for the current frame."));
					return;
				}

				candidate = self._bestPlaceForDirection(results, location, options.direction || "ahead");
				if (!candidate && !options.direction) {
					candidate = self._nearestPlace(results, location, 60);
				}
				if (!candidate) {
					if (self.answerFormatter && self.answerFormatter.formatGuideAnswer && options.text && results.length) {
						self._deliverAnswer(null, options.direction || "ahead", results.length, options.text || "", callback, results);
						return;
					}
					callback(new Error("No confident named place found in the current view."));
					return;
				}

				self._details(candidate, function(detailsError, resolved) {
					if (contextVersion !== self._contextVersion) {
						callback(new Error("Place lookup was refreshed for the current frame."));
						return;
					}
					if (detailsError) {
						callback(detailsError);
						return;
					}

					self._deliverAnswer(resolved, options.direction || "ahead", results.length, options.text || "", callback, results);
				});
			};

			self._nearbyPlaces(directionLocation, function(directionError, directionResults) {
				var previousLocation = self._frameLocation(-1);
				var nextLocation = self._frameLocation(1);
				var groups = [directionResults || [], nearbyResults || []];
				var finishMerged = function(previousResults, nextResults) {
					var merged = self._mergePlaces(groups.concat([previousResults || [], nextResults || []]));
					if (!merged.length) {
						callback(new Error((nearbyError && nearbyError.message) || (directionError && directionError.message) || "No named places found nearby."));
						return;
					}
					finish(merged);
				};
				var finishWithPrevious = function(previousResults) {
					if (!nextLocation) {
						finishMerged(previousResults, []);
						return;
					}
					self._nearbyPlaces(nextLocation, function(_nextError, nextResults) {
						finishMerged(previousResults, nextResults);
					}, { radius: Math.max(self.radius, 350), suffix: "next-frame-identify", collectAll: true });
				};

				if (!previousLocation) {
					finishWithPrevious([]);
					return;
				}
				self._nearbyPlaces(previousLocation, function(_previousError, previousResults) {
					finishWithPrevious(previousResults);
				}, { radius: Math.max(self.radius, 350), suffix: "previous-frame-identify", collectAll: true });
			}, { radius: Math.max(self.radius, 350), suffix: (options.direction || "ahead") + "-identify", collectAll: true });
		}, { radius: Math.max(this.radius, 350), suffix: "nearby-identify", collectAll: true });
	};

	TourGuide.prototype.handleQuestion = function(text, callback) {
		var command;

		if (!global.VoiceOrchestrator) {
			this.identifyView({}, callback);
			return;
		}

		command = new global.VoiceOrchestrator().parseCommand(text);
		if (command.type === "list_nearby_places") {
			this.listNearbyPlaces(callback);
		} else {
			this.identifyView({ direction: command.direction, text: text }, callback);
		}
	};

	TourGuide.prototype.listNearbyPlaces = function(callback) {
		callback = callback || function() {};

		var self = this;
		var location = this._currentLocation();

		if (!location) {
			callback(new Error("Places lookup is not available yet."));
			return;
		}

		this._nearbyPlaces(location, function(error, results) {
			var names;
			var text;

			if (error) {
				callback(error);
				return;
			}

			names = results.slice(0, 5).map(function(place) { return place.name; }).filter(Boolean);
			if (!names.length) {
				callback(new Error("No named places found nearby."));
				return;
			}

			text = "Nearby places include " + names.join(", ") + ". Ask what is ahead, left, or right to focus on one.";
			self.onInfo({ text: text, places: results });
			self._speak(text);
			callback(null, { text: text, places: results });
		});
	};

	global.TourGuide = TourGuide;
})(window);
