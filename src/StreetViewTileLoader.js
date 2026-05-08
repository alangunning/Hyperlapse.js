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
		_tile_retries = typeof _parameters.tileRetries === "number" ? _parameters.tileRetries : 6,
		_request_spacing_ms = typeof _parameters.requestSpacingMillis === "number" ? _parameters.requestSpacingMillis : 125,
		_last_request_at = 0,
		_canvas = document.createElement("canvas"),
		_ctx = _canvas.getContext("2d"),
		_metadata_by_pano = {};

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

	function requestBlob(url) {
		return throttledFetch(url).then(function(response) {
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

	function loadTileImage(url) {
		return requestBlob(url).then(function(blob) {
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

	function loadTileWithRetry(url, retries) {
		return loadTileImage(url).catch(function(error) {
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
				return loadTileWithRetry(url, retries - 1);
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
		}, _tile_retries).then(function(response) {
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

			return requestJsonWithRetry(url, null, _tile_retries).then(function(metadata) {
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
			if (self.onPanoramaLoad) {
				self.onPanoramaLoad();
			}
		}

		function tileComplete() {
			count++;
			self.setProgress(Math.round(count * 100 / total));
			if (count === total && !failed) {
				done();
			}
		}

			this.ensureSession().then(function(session) {
				for (var y = 0; y < tiles_y; y++) {
					for (var x = 0; x < tiles_x; x++) {
						(function(tile_x, tile_y) {
							loadTileWithRetry(tileUrl(session, metadata.panoId, tile_x, tile_y), _tile_retries).then(function(img) {
								if (failed) {
									return;
								}
								temp_ctx.drawImage(img, tile_x * tile_width, tile_y * tile_height);
								tileComplete();
							}).catch(function(error) {
								failed = true;
								self.throwError("Could not load Street View tile " + tile_x + "," + tile_y + ": " + error.message);
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
