/**
 * @overview Local Street View panorama tile loader backed by the Google Map Tiles API.
 * Replaces the historical GSVPano.js/cbk tile dependency.
 */
var StreetViewTileLoader = function(parameters) {
	"use strict";

	var _parameters = parameters || {},
		_zoom = clampZoom(_parameters.zoom || 1),
		_api_key = _parameters.apiKey || _parameters.key || "",
		_session = _parameters.session || "",
		_session_expiry = 0,
		_language = _parameters.language || "en-US",
		_region = _parameters.region || "US",
		_radius = _parameters.radius || 50,
		_static_base_url = _parameters.staticBaseUrl || "",
		_image_source_mode = _parameters.imageSourceMode || "auto",
		_tile_retries = typeof _parameters.tileRetries === "number" ? _parameters.tileRetries : 0,
		_metadata_retries = typeof _parameters.metadataRetries === "number" ? _parameters.metadataRetries : 2,
		_request_spacing_ms = typeof _parameters.requestSpacingMillis === "number" ? _parameters.requestSpacingMillis : 0,
		_last_request_at = 0,
		_canvas = document.createElement("canvas"),
		_ctx = _canvas.getContext("2d"),
		_metadata_by_pano = {};

	function todayKey() {
		return new Date().toISOString().slice(0, 10);
	}

	function defaultQuotaState() {
		return {
			date: todayKey(),
			tileRequests: 0,
			tileSuccesses: 0,
			tile429s: 0,
			staticFallbacks: 0,
			lastStatus: null,
			likelyDailyQuotaExhausted: false,
			lastUpdatedAt: 0
		};
	}

	function storage() {
		return typeof window !== "undefined" ? window.localStorage : null;
	}

	function readQuotaState() {
		var key = "hyperlapse.mapTilesQuota." + todayKey();
		var state;

		try {
			state = JSON.parse(storage() && storage().getItem(key));
		} catch(e) {
			state = null;
		}
		if (!state || state.date !== todayKey()) {
			state = defaultQuotaState();
		}
		return state;
	}

	function writeQuotaState(state) {
		var key = "hyperlapse.mapTilesQuota." + todayKey();

		state.lastUpdatedAt = Date.now();
		try {
			if (storage()) {
				storage().setItem(key, JSON.stringify(state));
			}
		} catch(e) {}
		return state;
	}

	function updateQuotaState(updater) {
		var state = readQuotaState();

		updater(state);
		writeQuotaState(state);
		if (this.onQuotaUpdate) {
			this.onQuotaUpdate(state);
		}
		return state;
	}

	function clampZoom(zoom) {
		return Math.max(0, Math.min(5, Math.floor(zoom)));
	}

	function toLatLngLiteral(location) {
		return {
			lat: typeof location.lat === "function" ? location.lat() : location.lat,
			lng: typeof location.lng === "function" ? location.lng() : location.lng
		};
	}

	function requestError(response) {
		var error = new Error("Request failed with HTTP " + response.status);
		error.status = response.status;
		error.retryAfter = Number(response.headers && response.headers.get("Retry-After")) || 0;
		return error;
	}

	function throttledFetch(url, options) {
		var now = Date.now();
		var wait = Math.max(0, _last_request_at + _request_spacing_ms - now);
		_last_request_at = now + wait;

		return delay(wait).then(function() {
			return fetch(url, options);
		});
	}

	function drawPlaceholder(width, height, message) {
		_canvas.width = Math.max(512, width || 512);
		_canvas.height = Math.max(256, height || 256);
		_ctx.save();
		_ctx.setTransform(1, 0, 0, 1, 0, 0);
		_ctx.fillStyle = "#222";
		_ctx.fillRect(0, 0, _canvas.width, _canvas.height);
		_ctx.fillStyle = "#333";
		_ctx.fillRect(0, 0, _canvas.width, _canvas.height / 2);
		_ctx.fillStyle = "#fff";
		_ctx.font = "24px Arial, sans-serif";
		_ctx.textAlign = "center";
		_ctx.fillText("Street View frame unavailable", _canvas.width / 2, _canvas.height / 2 - 12);
		_ctx.font = "16px Arial, sans-serif";
		_ctx.fillStyle = "#d0d7de";
		_ctx.fillText(message || "Retry later or lower the route density.", _canvas.width / 2, _canvas.height / 2 + 20);
		_ctx.restore();
		this.canvas = _canvas;
	}

	function requestJson(url, options) {
		return throttledFetch(url, options).then(function(response) {
			if (!response.ok) {
				throw requestError(response);
			}
			return response.json();
		});
	}

	function requestJsonWithRetry(url, options, retries) {
		return requestJson(url, options).catch(function(error) {
			var retryDelay;

			if (error.status !== 429 || retries <= 0) {
				throw error;
			}
			retryDelay = Math.min(30000, Math.max(error.retryAfter * 1000, Math.pow(2, _tile_retries - retries + 1) * 1000));
			_last_request_at = Math.max(_last_request_at, Date.now() + retryDelay);
			return delay(retryDelay).then(function() {
				return requestJsonWithRetry(url, options, retries - 1);
			});
		});
	}

	function requestBlob(url, options) {
		options = options || {};
		return throttledFetch(url).then(function(response) {
			if (options.mapTiles) {
				updateQuotaState.call(options.owner, function(state) {
					state.tileRequests++;
					state.lastStatus = response.status;
					if (response.status === 429) {
						state.tile429s++;
						state.likelyDailyQuotaExhausted = true;
					} else if (response.ok) {
						state.tileSuccesses++;
					}
				});
			}
			if (!response.ok) {
				throw requestError(response);
			}
			return response.blob();
		});
	}

	function delay(milliseconds) {
		return new Promise(function(resolve) {
			window.setTimeout(resolve, milliseconds);
		});
	}

	function tileUrl(session, panoId, tileX, tileY) {
		return "https://tile.googleapis.com/v1/streetview/tiles/" +
			_zoom + "/" + tileX + "/" + tileY +
			"?session=" + encodeURIComponent(session) +
			"&key=" + encodeURIComponent(_api_key) +
			"&panoId=" + encodeURIComponent(panoId);
	}

	function staticFallbackUrl(metadata) {
		var params;

		if (!_static_base_url || !metadata || typeof metadata.lat === "undefined" || typeof metadata.lng === "undefined") {
			return "";
		}
		params = new URLSearchParams({
			lat: metadata.lat,
			lng: metadata.lng,
			heading: metadata.heading || 0,
			pitch: 0,
			fov: 90,
			size: "640x320"
		});
		return _static_base_url + "?" + params.toString();
	}

	function staticImage(metadata, message, self, onUnavailable) {
		var url = staticFallbackUrl(metadata);

		if (!url) {
			onUnavailable(message);
			return;
		}
		loadTileImage(url).then(function(img) {
			_canvas.width = 640;
			_canvas.height = 320;
			_ctx.save();
			_ctx.setTransform(1, 0, 0, 1, 0, 0);
			_ctx.clearRect(0, 0, _canvas.width, _canvas.height);
			_ctx.drawImage(img, 0, 0, _canvas.width, _canvas.height);
			_ctx.restore();
			self.canvas = _canvas;
			self.placeholder = false;
			self.staticFallback = _image_source_mode !== "static";
			self.staticOnly = _image_source_mode === "static";
			updateQuotaState.call(self, function(state) {
				if (_image_source_mode !== "static") {
					state.staticFallbacks++;
				}
			});
			if (self.onPanoramaFallback) {
				self.onPanoramaFallback({ message: message, sourceMode: _image_source_mode });
			}
			if (self.onPanoramaLoad) {
				self.onPanoramaLoad();
			}
		}).catch(function() {
			onUnavailable(message);
		});
	}

	function loadTileImage(url, options) {
		return requestBlob(url, options).then(function(blob) {
			return new Promise(function(resolve, reject) {
				var img = new Image(),
					objectUrl = URL.createObjectURL(blob);

				img.addEventListener("load", function() {
					URL.revokeObjectURL(objectUrl);
					resolve(img);
				});
				img.addEventListener("error", function() {
					URL.revokeObjectURL(objectUrl);
					reject(new Error("Browser could not decode Street View tile image."));
				});
				img.src = objectUrl;
			});
		});
	}

	function loadTileWithRetry(url, retries, owner) {
		return loadTileImage(url, { mapTiles: true, owner: owner }).catch(function(error) {
			var retryDelay;

			if (retries <= 0) {
				throw error;
			}
			retryDelay = error.status === 429 ?
				Math.min(30000, Math.max(error.retryAfter * 1000, Math.pow(2, _tile_retries - retries + 1) * 1000)) :
				(_tile_retries - retries + 1) * 250;
			if (error.status === 429) {
				_last_request_at = Math.max(_last_request_at, Date.now() + retryDelay);
			}
			return delay(retryDelay).then(function() {
				return loadTileWithRetry(url, retries - 1, owner);
			});
		});
	}

	function requireApiKey() {
		if (!_api_key) {
			throw new Error("Street View tile loading requires a Google Map Tiles API key. Pass streetViewApiKey when creating Hyperlapse.");
		}
	}

	this.setProgress = function(p) {
		if (this.onProgress) {
			this.onProgress(p);
		}
	};

	this.throwError = function(message) {
		if (this.onError) {
			this.onError(message);
		} else {
			console.error(message);
		}
	};

	this.setZoom = function(zoom) {
		_zoom = clampZoom(zoom);
	};

	this.setImageSourceMode = function(mode) {
		_image_source_mode = mode === "static" || mode === "tiles" ? mode : "auto";
	};

	this.getImageSourceMode = function() {
		return _image_source_mode;
	};

	this.getQuotaState = function() {
		return readQuotaState();
	};

	this.ensureSession = function() {
		requireApiKey();

		if (_session && (!_session_expiry || Date.now() / 1000 < _session_expiry - 60)) {
			return Promise.resolve(_session);
		}

			return requestJsonWithRetry("https://tile.googleapis.com/v1/createSession?key=" + encodeURIComponent(_api_key), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mapType: "streetview",
				language: _language,
				region: _region
			})
		}, _metadata_retries).then(function(response) {
			_session = response.session;
			_session_expiry = parseInt(response.expiry, 10) || 0;
			return _session;
		});
	};

	this.getMetadata = function(locationOrPanoId) {
		var self = this;

		return this.ensureSession().then(function(session) {
			var url = "https://tile.googleapis.com/v1/streetview/metadata?session=" +
				encodeURIComponent(session) + "&key=" + encodeURIComponent(_api_key);

			if (typeof locationOrPanoId === "string") {
				if (_metadata_by_pano[locationOrPanoId]) {
					return _metadata_by_pano[locationOrPanoId];
				}
				url += "&panoId=" + encodeURIComponent(locationOrPanoId);
			} else {
				var latLng = toLatLngLiteral(locationOrPanoId);
				url += "&lat=" + encodeURIComponent(latLng.lat) +
					"&lng=" + encodeURIComponent(latLng.lng) +
					"&radius=" + encodeURIComponent(_radius);
			}

			return requestJsonWithRetry(url, null, _metadata_retries).then(function(metadata) {
				if (!metadata || !metadata.panoId) {
					throw new Error("No Street View panorama found.");
				}
				_metadata_by_pano[metadata.panoId] = metadata;
				if (self.onPanoramaData) {
					self.onPanoramaData(metadata);
				}
				return metadata;
			});
		});
	};

	this.composeFromMetadata = function(metadata) {
		var self = this,
			tile_width = metadata.tileWidth || 512,
			tile_height = metadata.tileHeight || 512,
			scale = Math.pow(2, 5 - _zoom),
			image_width = Math.max(tile_width, Math.ceil((metadata.imageWidth || tile_width) / scale)),
			image_height = Math.max(tile_height, Math.ceil((metadata.imageHeight || tile_height / 2) / scale)),
			tiles_x = Math.max(1, Math.ceil(image_width / tile_width)),
			tiles_y = Math.max(1, Math.ceil(image_height / tile_height)),
			temp_canvas = document.createElement("canvas"),
			temp_ctx = temp_canvas.getContext("2d"),
			total = tiles_x * tiles_y,
			count = 0,
			failed = false;

		temp_canvas.width = tiles_x * tile_width;
		temp_canvas.height = tiles_y * tile_height;
		_canvas.width = image_width;
		_canvas.height = Math.max(1, Math.round(image_width / 2));

		function done() {
			_ctx.save();
			_ctx.setTransform(1, 0, 0, 1, 0, 0);
			_ctx.clearRect(0, 0, _canvas.width, _canvas.height);
			_ctx.translate(_canvas.width, 0);
			_ctx.scale(-1, 1);
			_ctx.drawImage(temp_canvas, 0, 0, image_width, image_height, 0, 0, _canvas.width, _canvas.height);
			_ctx.restore();
			self.canvas = _canvas;
			self.placeholder = false;
			self.staticFallback = false;
			self.staticOnly = false;
			if (self.onPanoramaLoad) {
				self.onPanoramaLoad();
			}
		}

		function placeholder(message) {
			if (failed) return;
			failed = true;
			drawPlaceholder.call(self, image_width, Math.max(1, Math.round(image_width / 2)), message);
			self.placeholder = true;
			self.staticFallback = false;
			self.staticOnly = false;
			if (self.onPanoramaPlaceholder) {
				self.onPanoramaPlaceholder({ message: message });
			}
			if (self.onPanoramaLoad) {
				self.onPanoramaLoad();
			}
		}

		function staticFallback(message) {
			if (failed) return;
			failed = true;
			staticImage(metadata, message, self, function(unavailableMessage) {
				failed = false;
				placeholder(unavailableMessage);
			});
		}

		function tileComplete() {
			count++;
			self.setProgress(Math.round(count * 100 / total));
			if (count === total && !failed) {
				done();
			}
		}

		if (_image_source_mode === "static") {
			staticFallback("Using Street View Static source for this frame.");
			return;
		}

			this.ensureSession().then(function(session) {
				for (var y = 0; y < tiles_y; y++) {
					for (var x = 0; x < tiles_x; x++) {
						(function(tile_x, tile_y) {
							loadTileWithRetry(tileUrl(session, metadata.panoId, tile_x, tile_y), _tile_retries, self).then(function(img) {
								if (failed) {
									return;
								}
								temp_ctx.drawImage(img, tile_x * tile_width, tile_y * tile_height);
								tileComplete();
							}).catch(function(error) {
								if (_image_source_mode === "tiles") {
									placeholder("Could not load Street View tile " + tile_x + "," + tile_y + ": " + error.message);
								} else {
									staticFallback("Could not load Street View tile " + tile_x + "," + tile_y + ": " + error.message);
								}
							});
						})(x, y);
					}
				}
		}).catch(function(error) {
			self.throwError(error.message);
		});
	};

	this.composePanorama = function(panoId) {
		var self = this;

		this.setProgress(0);
		this.getMetadata(panoId).then(function(metadata) {
			self.composeFromMetadata(metadata);
		}).catch(function(error) {
			self.throwError(error.message);
		});
	};

	this.load = function(location, callback) {
		var self = this;

		this.getMetadata(location).then(function(metadata) {
			var latLng = new google.maps.LatLng(metadata.lat, metadata.lng);

			self.copyright = metadata.copyright || "";
			self.location = latLng;
			self.rotation = (metadata.heading || 0) * Math.PI / 180.0;
			self.pitch = (metadata.tilt || 90) - 90;
			self.roll = metadata.roll || 0;
			self.image_date = metadata.date || "";
			self.id = metadata.panoId;
			callback();
		}).catch(function(error) {
			if (self.onNoPanoramaData) {
				self.onNoPanoramaData(error.message);
			}
			self.throwError(error.message);
			callback(error);
		});
	};
};
