(function(global) {
	function OpenAIIntentInterpreter(options) {
		options = options || {};
		this.endpoint = options.endpoint || "/api/openai/interpret";
		this.answerEndpoint = options.answerEndpoint || "/api/openai/guide-answer";
		this.configEndpoint = options.configEndpoint || "/api/openai/config";
		this.timeoutMillis = options.timeoutMillis || 12000;
		this._disabled = false;
		this._configLoaded = false;
		this._configPromise = null;
		this.attachStreetViewImage = false;
	}

	OpenAIIntentInterpreter.prototype.isAvailable = function() {
		return !this._disabled && !!global.fetch;
	};

	OpenAIIntentInterpreter.prototype.loadConfig = function() {
		if (this._configPromise) return this._configPromise;
		this._configPromise = fetch(this.configEndpoint).then(function(response) {
			if (!response.ok) return null;
			return response.json();
		}).then(function(config) {
			this.attachStreetViewImage = !!(config && config.attachStreetViewImage);
			this._configLoaded = true;
			return config;
		}.bind(this)).catch(function() {
			this._configLoaded = true;
			return null;
		}.bind(this));
		return this._configPromise;
	};

	OpenAIIntentInterpreter.prototype.interpret = function(text, context) {
		var controller = global.AbortController ? new AbortController() : null;
		var timer = null;
		var self = this;

		if (!this.isAvailable()) {
			return Promise.reject(new Error("OpenAI interpreter is disabled."));
		}

		if (controller) {
			timer = global.setTimeout(function() {
				controller.abort();
			}, this.timeoutMillis);
		}

		return fetch(this.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: text, context: context || {} }),
			signal: controller && controller.signal
		}).then(function(response) {
			if (timer) global.clearTimeout(timer);
			if (response.status === 404 || response.status === 501) {
				self._disabled = true;
				throw new Error("No local OpenAI endpoint is configured.");
			}
			if (!response.ok) {
				throw new Error("OpenAI interpreter request failed with HTTP " + response.status + ".");
			}
			return response.json();
		}).then(function(payload) {
			if (!payload || !payload.command || !payload.command.type) {
				throw new Error("OpenAI interpreter returned an invalid command.");
			}
			return payload.command;
		});
	};

	OpenAIIntentInterpreter.prototype.formatGuideAnswer = function(question, placeResult, context) {
		if (!this.isAvailable()) {
			return Promise.reject(new Error("OpenAI guide formatter is disabled."));
		}
		if (!this._configLoaded) {
			return this.loadConfig().then(function() {
				return this.formatGuideAnswer(question, placeResult, context);
			}.bind(this));
		}

		return fetch(this.answerEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				question: question || "",
				localSelectedPlace: placeResult && (placeResult.localSelectedPlace || placeResult.serializedPlace || placeResult.place),
				candidates: placeResult && placeResult.candidates,
				candidateCount: placeResult && placeResult.candidateCount,
				context: context || {}
			})
		}).then(function(response) {
			if (response.status === 404 || response.status === 501) {
				throw new Error("No local OpenAI guide formatter is configured.");
			}
			if (!response.ok) {
				throw new Error("OpenAI guide formatter failed with HTTP " + response.status + ".");
			}
			return response.json();
		}).then(function(payload) {
			if (!payload || !payload.text) {
				throw new Error("OpenAI guide formatter returned no text.");
			}
			return payload.text;
		});
	};

	global.OpenAIIntentInterpreter = OpenAIIntentInterpreter;
})(window);
