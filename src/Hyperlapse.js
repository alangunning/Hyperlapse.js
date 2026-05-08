/**
 * @overview Hyperapse.js - JavaScript hyper-lapse utility for Google Street View.
 * @author Peter Nitsch
 * @copyright Teehan+Lax 2013
 */

Number.prototype.toRad = function() {
	return this * Math.PI / 180;
};

Number.prototype.toDeg = function() {
	return this * 180 / Math.PI;
};

// Array Remove - By John Resig (MIT Licensed)
Array.prototype.remove = function(from, to) {
  var rest = this.slice((to || from) + 1 || this.length);
  this.length = from < 0 ? this.length + from : from;
  return this.push.apply(this, rest);
};

var pointOnLine = function(t, a, b) {
	var lat1 = a.lat().toRad(), lon1 = a.lng().toRad();
	var lat2 = b.lat().toRad(), lon2 = b.lng().toRad();

	var x = lat1 + t * (lat2 - lat1);
	var y = lon1 + t * (lon2 - lon1);

	return new google.maps.LatLng(x.toDeg(), y.toDeg());
};

var normalizeAngle = function(angle) {
	return ((angle % 360) + 540) % 360 - 180;
};

/**
 * @class
 * @classdesc Value object for a single point in a Hyperlapse sequence.
 * @constructor
 * @param {google.maps.LatLng} location
 * @param {String} pano_id
 * @param {Object} params
 * @param {Number} [params.heading=0]
 * @param {Number} [params.pitch=0]
 * @param {Number} [params.elevation=0]
 * @param {Image} [params.image=null]
 * @param {String} [params.copyright="© 2013 Google"]
 * @param {String} [params.image_date=""]
 */
var HyperlapsePoint = function(location, pano_id, params ) {

	var self = this;
	var params = params || {};

	/**
	 * @type {google.maps.LatLng}
	 */
	this.location = location;

	/**
	 * @type {Number}
	 */
	this.pano_id = pano_id;

	/**
	 * @default 0
	 * @type {Number}
	 */
	this.heading = params.heading || 0;

	/**
	 * @default 0
	 * @type {Number}
	 */
	this.pitch = params.pitch || 0;

	/**
	 * @default 0
	 * @type {Number}
	 */
	this.elevation = params.elevation || 0;

	/**
	 * @type {Image}
	 */
	this.image = params.image || null;

	/**
	 * @default "© 2013 Google"
	 * @type {String}
	 */
	this.copyright = params.copyright || "© 2013 Google";

	/**
	 * @type {String}
	 */
	this.image_date = params.image_date || "";

};

/**
 * @class
 * @constructor
 * @param {Node} container - HTML element
 * @param {Object} params
 * @param {Number} [params.width=800]
 * @param {Number} [params.height=400]
 * @param {boolean} [params.use_elevation=false]
 * @param {Number} [params.distance_between_points=5]
 * @param {Number} [params.max_points=100]
 * @param {Number} [params.fov=70]
 * @param {Number} [params.zoom=1]
 * @param {google.maps.LatLng} [params.lookat=null]
 * @param {Number} [params.millis=50]
 * @param {Number} [params.elevation=0]
 * @param {Number} [params.tilt=0]
 */
var Hyperlapse = function(container, params) {

	"use strict";

	var self = this,
		_event_listeners = {},
		_container = container,
		_params = params || {},
		_w = _params.width || 800,
		_h = _params.height || 400,
		_d = 20,
		_use_elevation = _params.use_elevation || false,
		_distance_between_points = _params.distance_between_points || 5,
		_max_points = _params.max_points || 100,
		_fov = _params.fov || 70,
		_zoom = _params.zoom || 1,
		_lat = 0, _lon = 0,
		_position_x = 0, _position_y = 0,
		_is_playing = false, _is_loading = false,
		_is_animating = false,
		_point_index = 0,
		_load_index = 0,
		_origin_heading = 0, _origin_pitch = 0,
		_forward = true,
		_lookat_heading = 0, _lookat_elevation = 0,
		_canvas, _context,
		_camera, _scene, _renderer, _mesh,
		_loader, _cancel_load = false,
		_ctime = Date.now(),
		_ptime = 0, _dtime = 0,
		_prev_pano_id = null,
		_last_good_image = null,
		_raw_points = [], _h_points = [],
		_is_recording = false,
		_recording_chunks = [],
		_recording_mime_type = "video/webm",
		_recording_blob = null,
		_recorder = null;

	/**
	 * @event Hyperlapse#onError
 	 * @param {Object} e
 	 * @param {String} e.message
	 */
	var emit = function(type, detail, legacyCallback) {
		var listeners = _event_listeners[type] || [];
		var event = detail || {};
		var i;

		event.type = type;
		event.target = self;

		if (legacyCallback && self[legacyCallback]) {
			self[legacyCallback](event);
		}

		listeners = listeners.slice(0);
		for (i = 0; i < listeners.length; i++) {
			try {
				listeners[i](event);
			} catch (error) {
				setTimeout(function() { throw error; }, 0);
			}
		}
	};

	var frameEvent = function(source) {
		return {
			position: _point_index,
			point: _h_points[_point_index],
			source: source || "frame",
			heading: self.getCameraHeading ? self.getCameraHeading() : 0,
			look: {
				x: self.position.x,
				y: self.position.y
			}
		};
	};

	/**
	 * @event Hyperlapse#onError
 	 * @param {Object} e
 	 * @param {String} e.message
	 */
	var handleError = function (e) { emit("error", e, "onError"); };

	/**
	 * @event Hyperlapse#onFrame
	 * @param {Object} e
 	 * @param {Number} e.position
 	 * @param {HyperlapsePoint} e.point
	 */
	var handleFrame = function (e) { emit("frame", e, "onFrame"); };

	/**
	 * @event Hyperlapse#onPlay
	 */
	var handlePlay = function (e) { emit("play", e, "onPlay"); };

	/**
	 * @event Hyperlapse#onPause
	 */
	var handlePause = function (e) { emit("pause", e, "onPause"); };

	/**
	 * @event Hyperlapse#onRecordStart
	 */
	var handleRecordStart = function (e) { emit("recordstart", e, "onRecordStart"); };

	/**
	 * @event Hyperlapse#onRecordProgress
	 */
	var handleRecordProgress = function (e) { emit("recordprogress", e, "onRecordProgress"); };

	/**
	 * @event Hyperlapse#onRecordComplete
	 */
	var handleRecordComplete = function (e) { emit("recordcomplete", e, "onRecordComplete"); };

	var _elevator = new google.maps.ElevationService();

	_canvas = document.createElement( 'canvas' );
	_context = _canvas.getContext( '2d' );

	_camera = new THREE.PerspectiveCamera( _fov, _w/_h, 1, 1100 );
	_camera.target = new THREE.Vector3( 0, 0, 0 );

	_scene = new THREE.Scene();
	_scene.add( _camera );

	_renderer = new THREE.WebGLRenderer( {
		antialias: true,
		preserveDrawingBuffer: _params.preserveDrawingBuffer || false
	} );
	_renderer.autoClear = true;
	_renderer.setSize( _w, _h );

	_mesh = new THREE.Mesh(
		new THREE.SphereGeometry( 500, 60, 40 ),
		new THREE.MeshBasicMaterial( { map: new THREE.Texture(), side: THREE.DoubleSide } )
	);
	_scene.add( _mesh );

	_container.appendChild( _renderer.domElement );

	_loader = new StreetViewTileLoader( {
		zoom: _zoom,
		apiKey: _params.streetViewApiKey || _params.googleMapsApiKey || _params.apiKey,
		session: _params.streetViewSession,
		staticBaseUrl: _params.streetViewStaticBaseUrl,
		imageSourceMode: _params.streetViewSourceMode,
		language: _params.language,
		region: _params.region,
		radius: _params.radius
	} );
	_loader.onError = function(message) {
		handleError({message:message});
	};
	_loader.onPanoramaPlaceholder = function(event) {
		emit("loadwarning", { message:event && event.message ? event.message : "Street View frame unavailable; using placeholder." });
	};
	_loader.onQuotaUpdate = function(state) {
		emit("maptilesquota", { state: state });
	};
	_loader.onPanoramaFallback = function(event) {
		emit("imagerysource", {
			source: event && event.sourceMode === "static" ? "static" : "static-fallback",
			message: event && event.message ? event.message : "Using Street View Static imagery."
		});
	};

	var loadedLength = function() {
		var count = 0;
		while (count < _h_points.length && _h_points[count].image) {
			count++;
		}
		return count;
	};

	_loader.onPanoramaLoad = function() {
		var canvas = document.createElement("canvas");
		var context = canvas.getContext('2d');
		canvas.setAttribute('width',this.canvas.width);
		canvas.setAttribute('height',this.canvas.height);
		if (this.placeholder && _last_good_image) {
			canvas.setAttribute('width',_last_good_image.width);
			canvas.setAttribute('height',_last_good_image.height);
			context = canvas.getContext('2d');
			context.drawImage(_last_good_image, 0, 0);
		} else {
			context.drawImage(this.canvas, 0, 0);
		}

		_h_points[_load_index].image = canvas;
		_h_points[_load_index].placeholder = !!this.placeholder;
		_h_points[_load_index].staticFallback = !!this.staticFallback;
		_h_points[_load_index].staticOnly = !!this.staticOnly;
		if (!this.placeholder) {
			_last_good_image = canvas;
		}

		if(_load_index === 0) {
			_point_index = 0;
			drawMaterial();
			startAnimation();
			emit("loadready", {position:0, loaded:loadedLength(), total:_h_points.length});
		}

		if(++_load_index != _h_points.length) {
			handleLoadProgress( {position:_load_index, loaded:loadedLength(), total:_h_points.length} );

			if(!_cancel_load) {
				_loader.composePanorama( _h_points[_load_index].pano_id );
			} else {
				handleLoadCanceled( {} );
			}
		} else {
			handleLoadComplete( {} );
		}
	};

	/**
	 * @event Hyperlapse#onLoadCanceled
	 */
	var handleLoadCanceled = function (e) {
		_cancel_load = false;
		_is_loading = false;

		emit("loadcanceled", e, "onLoadCanceled");
	};

	/**
	 * @event Hyperlapse#onLoadProgress
	 * @param {Object} e
 	 * @param {Number} e.position
	 */
	var handleLoadProgress = function (e) { emit("loadprogress", e, "onLoadProgress"); };

	/**
	 * @event Hyperlapse#onLoadComplete
	 */
	var handleLoadComplete = function (e) {
		_is_loading = false;

		if (_h_points[_point_index] && _h_points[_point_index].image) {
			drawMaterial();
		}

		emit("loadcomplete", e, "onLoadComplete");
	};

	/**
	 * @event Hyperlapse#onRouteProgress
	 * @param {Object} e
 	 * @param {HyperlapsePoint} e.point
	 */
	var handleRouteProgress = function (e) { emit("routeprogress", e, "onRouteProgress"); };

	/**
	 * @event Hyperlapse#onRouteComplete
	 * @param {Object} e
	 * @param {google.maps.DirectionsResult} e.response
 	 * @param {Array<HyperlapsePoint>} e.points
	 */
	var handleRouteComplete = function (e) {
		var elevations = [];
		for(var i=0; i<_h_points.length; i++) {
			elevations[i] = _h_points[i].location;
		}

		if(_use_elevation) {
			getElevation(elevations, function(results){
				if(results) {
					for(i=0; i<_h_points.length; i++) {
						_h_points[i].elevation = results[i].elevation;
					}
				} else {
					for(i=0; i<_h_points.length; i++) {
						_h_points[i].elevation = -1;
					}
				}

				self.setLookat(self.lookat, true, function(){
					emit("routecomplete", e, "onRouteComplete");
				});
			});
		} else {
			for(i=0; i<_h_points.length; i++) {
				_h_points[i].elevation = -1;
			}

			self.setLookat(self.lookat, false, function(){
				emit("routecomplete", e, "onRouteComplete");
			});
		}


	};

	var parsePoints = function(response) {

		_loader.load( _raw_points[_point_index], function(error) {
			if (error) {
				handleLoadCanceled( {} );
				return;
			}

			if(_loader.id != _prev_pano_id) {
				_prev_pano_id = _loader.id;

				var hp = new HyperlapsePoint( _loader.location, _loader.id, {
					heading:_loader.rotation,
					pitch: _loader.pitch,
					elevation: _loader.elevation,
					copyright: _loader.copyright,
					image_date: _loader.image_date
				} );

				_h_points.push( hp );

				handleRouteProgress( {point: hp} );

				if(_point_index == _raw_points.length-1) {
					handleRouteComplete( {response: response, points: _h_points} );
				} else {
					_point_index++;
					if(!_cancel_load) parsePoints(response);
					else handleLoadCanceled( {} );
				}
			} else {

				_raw_points.splice(_point_index, 1);

				if(_point_index == _raw_points.length) {
					handleRouteComplete( {response: response, points: _h_points} ); // FIX
				} else {
					if(!_cancel_load) parsePoints(response);
					else handleLoadCanceled( {} );
				}

			}

		} );
	};

	var getElevation = function(locations, callback) {
		var positionalRequest = { locations: locations };

		_elevator.getElevationForLocations(positionalRequest, function(results, status) {
			if (status == google.maps.ElevationStatus.OK) {
				callback(results);
			} else {
				if(status == google.maps.ElevationStatus.OVER_QUERY_LIMIT) {
					console.log("Over elevation query limit.");
				}
				_use_elevation = false;
				callback(null);
			}
		});
	};

	var handleDirectionsRoute = function(response) {
		if(!_is_playing) {

			var route = response.routes[0];
			var path = route.overview_path;
			var legs = route.legs;

			var total_distance = 0;
			for(var i=0; i<legs.length; ++i) {
				total_distance += legs[i].distance.value;
			}

			var segment_length = total_distance/_max_points;
			_d = (segment_length < _distance_between_points) ? _d = _distance_between_points : _d = segment_length;

			var d = 0;
			var r = 0;
			var a, b;

			for(i=0; i<path.length; i++) {
				if(i+1 < path.length) {

					a = path[i];
					b = path[i+1];
					d = google.maps.geometry.spherical.computeDistanceBetween(a, b);

					if(r > 0 && r < d) {
						a = pointOnLine(r/d, a, b);
						d = google.maps.geometry.spherical.computeDistanceBetween(a, b);
						_raw_points.push(a);

						r = 0;
					} else if(r > 0 && r > d) {
						r -= d;
					}

					if(r === 0) {
						var segs = Math.floor(d/_d);

						if(segs > 0) {
							for(var j=0; j<segs; j++) {
								var t = j/segs;

								if( t>0 || (t+i)===0  ) { // not start point
									var way = pointOnLine(t, a, b);
									_raw_points.push(way);
								}
							}

							r = d-(_d*segs);
						} else {
							r = _d*( 1-(d/_d) );
						}
					}

				} else {
					_raw_points.push(path[i]);
				}
			}

			parsePoints(response);

		} else {
			self.pause();
			handleDirectionsRoute(response);
		}
	};

	var drawMaterial = function() {
		if (!_h_points[_point_index] || !_h_points[_point_index].image) {
			return;
		}
		if (_mesh.material.map && _mesh.material.map.dispose) {
			_mesh.material.map.dispose();
		}
		_mesh.material.map = new THREE.CanvasTexture(_h_points[_point_index].image);
		if (THREE.SRGBColorSpace) {
			_mesh.material.map.colorSpace = THREE.SRGBColorSpace;
		}
		_mesh.material.map.needsUpdate = true;

		_origin_heading = _h_points[_point_index].heading;
		_origin_pitch = _h_points[_point_index].pitch;

		if(self.follow_route && loadedLength() > 1) {
			var playable_length = loadedLength();
			var route_target_index = (_point_index + 1 < playable_length) ? _point_index + 1 : _point_index - 1;
			if (route_target_index >= 0) {
				_lookat_heading = google.maps.geometry.spherical.computeHeading(
					_h_points[_point_index].location,
					_h_points[route_target_index].location
				);
			}
		} else if(self.use_lookat && self.lookat) {
			_lookat_heading = google.maps.geometry.spherical.computeHeading( _h_points[_point_index].location, self.lookat );
		}

		if(_h_points[_point_index].elevation != -1 && self.lookat && !self.follow_route ) {
			var e = _h_points[_point_index].elevation - self.elevation_offset;
			var d = google.maps.geometry.spherical.computeDistanceBetween( _h_points[_point_index].location, self.lookat );
			var dif = _lookat_elevation - e;
			var angle = Math.atan( Math.abs(dif)/d ).toDeg();
			_position_y = (dif<0) ? -angle : angle;
		}

		handleFrame({
			position:_point_index,
			point: _h_points[_point_index],
			source: "frame",
			heading: self.getCameraHeading ? self.getCameraHeading() : 0,
			look: {
				x: self.position.x,
				y: self.position.y
			}
		});
	};

	var render = function() {
		if(loadedLength()>0 && _h_points[_point_index] && _h_points[_point_index].image) {
			var t = _point_index/(self.length());

			var o_x = self.position.x + (self.offset.x * t);
			var o_y = self.position.y + (self.offset.y * t);
			var o_z = self.tilt + (self.offset.z.toRad() * t);

			var o_heading = (self.use_lookat || self.follow_route) ? normalizeAngle(_lookat_heading - _origin_heading.toDeg() + o_x) : o_x;
			var o_pitch = _position_y + o_y;

			var olon = _lon, olat = _lat;
			_lon = _lon + normalizeAngle(o_heading - olon);
			_lat = _lat + ( o_pitch - olat );

			_lat = Math.max( - 85, Math.min( 85, _lat ) );
			var phi = ( 90 - _lat ).toRad();
			var theta = _lon.toRad();

			_camera.target.x = 500 * Math.sin( phi ) * Math.cos( theta );
			_camera.target.y = 500 * Math.cos( phi );
			_camera.target.z = 500 * Math.sin( phi ) * Math.sin( theta );
			_camera.lookAt( _camera.target );
			_camera.rotation.z -= o_z;

			if(self.use_rotation_comp) {
				_camera.rotation.z -= self.rotation_comp.toRad();
			}
			_mesh.rotation.z = _origin_pitch.toRad();
			_renderer.clear();
			_renderer.render( _scene, _camera );
		}
	};

	var startAnimation = function() {
		if (_is_animating) return;
		_is_animating = true;
		requestAnimationFrame( animate );
	};

	var animate = function() {
		var ptime = _ctime;
		_ctime = Date.now();
		_dtime += _ctime - ptime;
		if(_dtime >= self.millis) {
			if(_is_playing) loop();
			_dtime = 0;
		}
		requestAnimationFrame( animate );
		render();
	};

	// animates the playhead forward or backward depending on direction
	var loop = function() {
		var playable_length = loadedLength();
		if (!playable_length) return;
		if (_point_index >= playable_length) {
			_point_index = playable_length - 1;
		}
		drawMaterial();

		if(_forward) {
			if(++_point_index >= playable_length) {
				_point_index = playable_length - 1;
				if (!_is_loading) {
					_forward = !_forward;
				}
			}
		} else {
			if(--_point_index == -1) {
				_point_index = 0;
				_forward = !_forward;
			}
		}
	};


	/**
	 * @type {google.maps.LatLng}
	 */
	this.lookat = _params.lookat || null;

	/**
	 * @default 50
	 * @type {Number}
	 */
	this.millis = _params.millis || 50;

	/**
	 * @default 0
	 * @type {Number}
	 */
	this.elevation_offset = _params.elevation || 0;

	/**
	 * @deprecated should use offset instead
	 * @default 0
	 * @type {Number}
	 */
	this.tilt = _params.tilt || 0;

	/**
	 * @default {x:0, y:0}
	 * @type {Object}
	 */
	this.position = {x:0, y:0};

	/**
	 * @default {x:0, y:0, z:0}
	 * @type {Object}
	 */
	this.offset = {x:0, y:0, z:0};

	/**
	 * @default false
	 * @type {boolean}
	 */
	this.use_lookat = _params.use_lookat || false;

	/**
	 * @default false
	 * @type {boolean}
	 */
	this.follow_route = _params.follow_route || false;

	/**
	 * @default false
	 * @type {boolean}
	 */
	this.use_rotation_comp = false;

	/**
	 * @default 0
	 * @type {Number}
	 */
	this.rotation_comp = 0;

	/**
	 * Subscribe to Hyperlapse lifecycle events.
	 * Supported events include error, routeprogress, routecomplete,
	 * loadprogress, loadcomplete, frame, seek, play, pause, lookchange,
	 * resize, recordstart, recordprogress, and recordcomplete.
	 * @param {String} type
	 * @param {Function} listener
	 * @returns {Function} unsubscribe function
	 */
	this.addEventListener = function(type, listener) {
		if (!_event_listeners[type]) {
			_event_listeners[type] = [];
		}
		_event_listeners[type].push(listener);
		return function() {
			self.removeEventListener(type, listener);
		};
	};

	/**
	 * @param {String} type
	 * @param {Function} listener
	 */
	this.removeEventListener = function(type, listener) {
		var listeners = _event_listeners[type];
		var index;

		if (!listeners) return;
		index = listeners.indexOf(listener);
		if (index !== -1) {
			listeners.splice(index, 1);
		}
	};

	this.on = this.addEventListener;
	this.off = this.removeEventListener;

	/**
	 * @returns {boolean}
	 */
	this.isPlaying = function() { return _is_playing; };

	/**
	 * @returns {boolean}
	 */
	this.isLoading = function() { return _is_loading; };

	/**
	 * @returns {Number}
	 */
	this.length = function() { return _h_points.length; };

	/**
	 * @returns {Number}
	 */
	this.loadedLength = function() { return loadedLength(); };

	/**
	 * @param {Number} v
	 */
	this.setPitch = function(v) { _position_y = v; };

	/**
	 * Set free-look offset and emit a lookchange event.
	 * @param {Number} x
	 * @param {Number} y
	 */
	this.setLookOffset = function(x, y) {
		self.position.x = Math.max(-180, Math.min(180, x));
		self.position.y = Math.max(-85, Math.min(85, y));
		emit("lookchange", {
			x: self.position.x,
			y: self.position.y,
			position: _point_index,
			point: _h_points[_point_index] || null,
			heading: self.getCameraHeading ? self.getCameraHeading() : 0
		});
	};

	/**
	 * @param {Number} deltaX
	 * @param {Number} deltaY
	 */
	this.nudgeLook = function(deltaX, deltaY) {
		self.setLookOffset(self.position.x + deltaX, self.position.y + deltaY);
	};

	this.resetLook = function() {
		self.setLookOffset(0, 0);
	};

	/**
	 * @param {Number} v
	 */
	this.setDistanceBetweenPoint = function(v) { _distance_between_points = v; };

	/**
	 * @param {Number} v
	 */
	this.setMaxPoints = function(v) { _max_points = v; };

	/**
	 * @param {Number} v
	 */
	this.setTileZoom = function(v) {
		_zoom = v;
		if (_loader && _loader.setZoom) {
			_loader.setZoom(_zoom);
		}
		emit("tilequalitychange", { zoom:_zoom });
	};

	/**
	 * @returns {Number}
	 */
	this.getTileZoom = function() { return _zoom; };

	this.setStreetViewSourceMode = function(mode) {
		if (_loader && _loader.setImageSourceMode) {
			_loader.setImageSourceMode(mode);
		}
		emit("imagerysource", {
			source: mode === "static" ? "static" : mode === "tiles" ? "tiles" : "auto",
			message: "Street View source mode changed."
		});
	};

	this.getStreetViewSourceMode = function() {
		return _loader && _loader.getImageSourceMode ? _loader.getImageSourceMode() : "auto";
	};

	this.getMapTilesQuota = function() {
		return _loader && _loader.getQuotaState ? _loader.getQuotaState() : null;
	};

	/**
	 * Render the current camera view immediately, useful before capturing
	 * the canvas for image-grounded guide requests.
	 */
	this.renderFrame = function() { render(); };

	/**
	 * @returns {Number}
	 */
	this.fov = function() { return _fov; };

	/**
	 * @returns {THREE.WebGLRenderer}
	 */
	this.webgl = function() { return _renderer; };

	/**
	 * @returns {Image}
	 */
	this.getCurrentImage = function() {
		return _h_points[_point_index].image;
	};

	/**
	 * @returns {HyperlapsePoint}
	 */
	this.getCurrentPoint = function() {
		return _h_points[_point_index];
	};

	/**
	 * @param {Number} index
	 * @returns {HyperlapsePoint}
	 */
	this.getPointAt = function(index) {
		return _h_points[index];
	};

	/**
	 * @returns {Number}
	 */
	this.getPosition = function() {
		return _point_index;
	};

	/**
	 * @returns {Number}
	 */
	this.getCameraHeading = function() {
		var heading = _origin_heading + _lon;
		return ((heading % 360) + 360) % 360;
	};

	/**
	 * @param {google.maps.LatLng} point
	 * @param {boolean} call_service
	 * @param {function} callback
	 */
	this.setLookat = function(point, call_service, callback) {
		self.lookat = point;

		if(_use_elevation && call_service) {
			var e = getElevation([self.lookat], function(results){
				if(results) {
					_lookat_elevation = results[0].elevation;
				}

				if(callback && callback.apply) callback();
			});
		} else {
			if(callback && callback.apply) callback();
		}

	};

	/**
	 * @param {Number} v
	 */
	this.setFOV = function(v) {
		_fov = Math.floor(v);
		_camera.fov = _fov;
		_camera.aspect = _w/_h;
		_camera.near = 1;
		_camera.far = 1100;
		_camera.updateProjectionMatrix();
	};

	/**
	 * @param {Number} width
	 * @param {Number} height
	 */
	this.setSize = function(width, height) {
		_w = width;
		_h = height;
		_renderer.setSize( _w, _h );
		_camera.aspect = _w/_h;
		_camera.updateProjectionMatrix();
		emit("resize", { width:_w, height:_h });
	};

	/**
	 * Resets all members to defaults
	 */
	this.reset = function() {
		_raw_points.remove(0,-1);
		_h_points.remove(0,-1);

		self.tilt = 0;

		_lat = 0;
		_lon = 0;

		self.position.x = 0;
		self.offset.x = 0;
		self.offset.y = 0;
		self.offset.z = 0;
		_position_x = 0;
		_position_y = 0;

		_point_index = 0;
		_load_index = 0;
		_last_good_image = null;
		_origin_heading = 0;
		_origin_pitch = 0;

		_forward = true;
	};

	/**
	 * @param {Object} parameters
	 * @param {Number} [parameters.distance_between_points]
	 * @param {Number} [parameters.max_points]
	 * @param {google.maps.DirectionsResult} parameters.route
	 */
	this.generate = function( params ) {

		if(!_is_loading) {
			_is_loading = true;
			self.reset();

			var p = params || {};
			_distance_between_points = p.distance_between_points || _distance_between_points;
			_max_points = p.max_points || _max_points;

			if(p.route) {
				handleDirectionsRoute(p.route);
			} else {
				console.log("No route provided.");
			}

		}

	};

	/**
	 * @fires Hyperlapse#onLoadComplete
	 */
	this.load = function() {
		if (!_h_points.length) {
			handleError({message:"No Street View route points are available to load."});
			return;
		}
		_is_loading = true;
		self.pause();
		_cancel_load = false;
		_load_index = 0;
		_loader.composePanorama(_h_points[_load_index].pano_id);
	};

	/**
	 * @fires Hyperlapse#onLoadCanceled
	 */
	this.cancel = function() {
		if(_is_loading) {
			_cancel_load = true;
		}
	};

	/**
	 * @returns {google.maps.LatLng}
	 */
	this.getCameraPosition = function() {
		return new google.maps.LatLng(_lat, _lon);
	};

	/**
	 * Animate through all frames in sequence
	 * @fires Hyperlapse#onPlay
	 */
	this.play = function() {
		if(loadedLength() > 0) {
			_is_playing = true;
			handlePlay({});
		}
	};

	/**
	 * Play forward from the current frame.
	 */
	this.playForward = function() {
		_forward = true;
		self.play();
	};

	/**
	 * Play backward from the current frame.
	 */
	this.playReverse = function() {
		_forward = false;
		self.play();
	};

	/**
	 * Pause animation
	 * @fires Hyperlapse#onPause
	 */
	this.pause = function() {
		_is_playing = false;
		handlePause({});
	};

	/**
	 * Display a specific loaded frame in sequence.
	 * @param {Number} position
	 * @fires Hyperlapse#onFrame
	 */
	this.seek = function(position) {
		var playable_length = loadedLength();
		if (!playable_length) return false;
		self.pause();
		_point_index = Math.max(0, Math.min(playable_length - 1, Math.round(position)));
		drawMaterial();
		emit("seek", frameEvent("seek"));
		return true;
	};

	/**
	 * @returns {boolean}
	 */
	this.isRecording = function() { return _is_recording; };

	/**
	 * @returns {Blob|null}
	 */
	this.getRecording = function() { return _recording_blob; };

	/**
	 * @param {Object} params
	 * @param {String} [params.mimeType="video/webm"]
	 * @param {Number} [params.videoBitsPerSecond]
	 * @param {Number} [params.frameRate=30]
	 */
	this.startRecording = function(params) {
		var p = params || {};
		var frame_rate = p.frameRate || 30;
		var options = {};

		if (typeof window.MediaRecorder === "undefined") {
			handleError({message:"Recording is not supported in this browser."});
			return false;
		}

		if (_is_recording) {
			return false;
		}

		if (!_renderer || !_renderer.domElement || !_renderer.domElement.captureStream) {
			handleError({message:"Canvas captureStream is not available."});
			return false;
		}

		_recording_chunks = [];
		_recording_blob = null;
		_recording_mime_type = p.mimeType || _recording_mime_type;
		options.mimeType = _recording_mime_type;

		if (p.videoBitsPerSecond) {
			options.videoBitsPerSecond = p.videoBitsPerSecond;
		}

		try {
			_recorder = new MediaRecorder(_renderer.domElement.captureStream(frame_rate), options);
		} catch(e) {
			handleError({message:"Unable to create MediaRecorder with the given options."});
			return false;
		}

		_recorder.ondataavailable = function(event) {
			if (event.data && event.data.size > 0) {
				_recording_chunks.push(event.data);
				handleRecordProgress({size:event.data.size});
			}
		};

		_recorder.onstop = function() {
			_is_recording = false;
			_recording_blob = new Blob(_recording_chunks, {type:_recording_mime_type});
			handleRecordComplete({blob:_recording_blob, mimeType:_recording_mime_type});
		};

		_recorder.onerror = function(event) {
			_is_recording = false;
			handleError({message: event && event.error ? event.error.message : "Recording failed."});
		};

		_recorder.start(500);
		_is_recording = true;
		handleRecordStart({mimeType:_recording_mime_type});
		return true;
	};

	/**
	 * @returns {boolean}
	 */
	this.stopRecording = function() {
		if (!_is_recording || !_recorder) {
			return false;
		}

		_recorder.stop();
		return true;
	};

	/**
	 * @param {String} [filename="hyperlapse-recording.webm"]
	 * @returns {boolean}
	 */
	this.downloadRecording = function(filename) {
		var name = filename || "hyperlapse-recording.webm";
		var link;
		var href;

		if (!_recording_blob) {
			return false;
		}

		href = window.URL.createObjectURL(_recording_blob);
		link = document.createElement("a");
		link.style.display = "none";
		link.href = href;
		link.download = name;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		window.URL.revokeObjectURL(href);
		return true;
	};

	/**
	 * Display next frame in sequence
	 * @fires Hyperlapse#onFrame
	 */
	this.next = function() {
		var playable_length = loadedLength();
		self.pause();

		if(_point_index + 1 < playable_length) {
			_point_index++;
			drawMaterial();
			emit("seek", frameEvent("next"));
		}
	};

	/**
	 * Display previous frame in sequence
	 * @fires Hyperlapse#onFrame
	 */
	this.prev = function() {
		self.pause();

		if(_point_index - 1 >= 0) {
			_point_index--;
			drawMaterial();
			emit("seek", frameEvent("prev"));
		}
	};
};
