(function(global) {
	function VoiceOrchestrator(options) {
		options = options || {};
		this.onTranscript = options.onTranscript || function() {};
		this.onCommand = options.onCommand || function() {};
		this.onError = options.onError || function() {};
		this.onState = options.onState || function() {};
		this._recognizer = null;
		this._listening = false;
	}

	VoiceOrchestrator.prototype.isSupported = function() {
		return !!(global.SpeechRecognition || global.webkitSpeechRecognition);
	};

	VoiceOrchestrator.prototype.start = function() {
		var RecognitionCtor = global.SpeechRecognition || global.webkitSpeechRecognition;
		var self = this;

		if (!RecognitionCtor) {
			this.onError({ message: "Web Speech API is not supported in this browser." });
			return false;
		}

		if (!this._recognizer) {
			this._recognizer = new RecognitionCtor();
			this._recognizer.continuous = true;
			this._recognizer.interimResults = true;
			this._recognizer.lang = "en-US";

			this._recognizer.onresult = function(event) {
				var i;
				var transcript = "";
				for (i = event.resultIndex; i < event.results.length; i++) {
					transcript += event.results[i][0].transcript;
				}
				self.onTranscript({ text: transcript.trim(), isFinal: event.results[event.results.length - 1].isFinal });
				if (event.results[event.results.length - 1].isFinal) {
					self.onCommand(self.parseCommand(transcript));
				}
			};

			this._recognizer.onerror = function(e) {
				self.onError({ message: e.error || "speech-recognition-error" });
			};

			this._recognizer.onend = function() {
				if (self._listening) {
					self._recognizer.start();
				}
			};
		}

		this._listening = true;
		this._recognizer.start();
		this.onState({ listening: true });
		return true;
	};

	VoiceOrchestrator.prototype.stop = function() {
		if (this._recognizer) {
			this._listening = false;
			this._recognizer.stop();
			this.onState({ listening: false });
			return true;
		}
		return false;
	};

	VoiceOrchestrator.prototype.parseCommand = function(text) {
		var t = (text || "").toLowerCase();
		var locationMatch;
		var direction = null;
		var wantsInfo = false;
		var wantsNearbyList = false;
		var wantsLook = false;
		var wantsStop = false;

		if (t.indexOf("left") !== -1) direction = "left";
		else if (t.indexOf("right") !== -1) direction = "right";
		else if (t.indexOf("up") !== -1 || t.indexOf("sky") !== -1) direction = "up";
		else if (t.indexOf("down") !== -1 || t.indexOf("ground") !== -1) direction = "down";
		else if (t.indexOf("ahead") !== -1 || t.indexOf("forward") !== -1 || t.indexOf("straight") !== -1) direction = "ahead";

		wantsStop = t.indexOf("stop") !== -1 || t.indexOf("pause") !== -1;
		wantsLook = t.indexOf("look") !== -1 || t.indexOf("turn") !== -1 || t.indexOf("face") !== -1;
		wantsInfo =
			t.indexOf("what is") !== -1 ||
			t.indexOf("what's") !== -1 ||
			t.indexOf("what am i looking at") !== -1 ||
			t.indexOf("tell me about") !== -1 ||
			t.indexOf("identify") !== -1 ||
			t.indexOf("building") !== -1 ||
			t.indexOf("landmark") !== -1 ||
			t.indexOf("site") !== -1 ||
			t.indexOf("sight") !== -1;
		wantsNearbyList =
			t.indexOf("what is around") !== -1 ||
			t.indexOf("what's around") !== -1 ||
			t.indexOf("what is nearby") !== -1 ||
			t.indexOf("what's nearby") !== -1 ||
			t.indexOf("places around") !== -1 ||
			t.indexOf("places nearby") !== -1;

		if (wantsNearbyList) {
			return { type: "list_nearby_places", raw: text };
		}
		if (wantsInfo) {
			return { type: "identify_view", direction: direction, pause: wantsStop, raw: text };
		}
		if (wantsLook && direction) {
			return { type: "look_direction", direction: direction, pause: wantsStop, raw: text };
		}
		if (t.indexOf("start") !== -1 || t.indexOf("play") !== -1 || t.indexOf("continue") !== -1) {
			return { type: "play", raw: text };
		}
		if (wantsStop) {
			return { type: "pause", raw: text };
		}
		if (t.indexOf("next") !== -1) {
			return { type: "next", raw: text };
		}
		if (t.indexOf("previous") !== -1 || t.indexOf("back") !== -1) {
			return { type: "prev", raw: text };
		}
		locationMatch = t.match(/go to (.+)$/);
		if (locationMatch && locationMatch[1]) {
			return { type: "reroute", locationText: locationMatch[1].trim(), raw: text };
		}
		return { type: "freeform", raw: text };
	};

	global.VoiceOrchestrator = VoiceOrchestrator;
})(window);
