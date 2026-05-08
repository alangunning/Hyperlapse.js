import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { execFile } from "node:child_process";

const root = resolve(process.cwd());
const envPath = join(root, ".env");
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "localhost";
const noOpen = process.argv.includes("--no-open");
const plan = process.argv.find((arg) => arg.startsWith("--plan="))?.slice("--plan=".length) ||
	"/examples/plans/three-arena-oconnell-street.json";

const mimeTypes = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml"
};

function parseEnv(text) {
	const values = {};

	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		let value;

		if (!trimmed || trimmed.startsWith("#") || !match) continue;
		value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		values[match[1]] = value;
	}

	return values;
}

async function loadEnvValues() {
	return existsSync(envPath) ? parseEnv(await readFile(envPath, "utf8")) : {};
}

async function loadApiKey(fileValues) {
	const key = process.env.GOOGLE_MAPS_API_KEY ||
		process.env.GOOGLE_API_KEY ||
		fileValues.GOOGLE_MAPS_API_KEY ||
		fileValues.GOOGLE_API_KEY;

	if (!key) {
		throw new Error("Missing GOOGLE_MAPS_API_KEY or GOOGLE_API_KEY in .env or the environment.");
	}

	return key;
}

function optionalOpenAIConfig(fileValues) {
	const apiKey = process.env.OPENAI_API_KEY || fileValues.OPENAI_API_KEY;

	if (!apiKey) return null;
	return {
		apiKey,
		model: process.env.OPENAI_MODEL || fileValues.OPENAI_MODEL || "gpt-5.5",
		attachStreetViewImage: /^(1|true|yes)$/i.test(process.env.OPENAI_GUIDE_ATTACH_STREETVIEW_IMAGE || fileValues.OPENAI_GUIDE_ATTACH_STREETVIEW_IMAGE || "")
	};
}

function sendNotFound(response) {
	response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
	response.end("Not found");
}

function readRequestJson(request) {
	return new Promise((resolveBody, reject) => {
		let body = "";
		const maxBodyBytes = 2 * 1024 * 1024;

		request.on("data", (chunk) => {
			body += chunk;
			if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
				reject(new Error("Request body is too large."));
				request.destroy();
			}
		});
		request.on("end", () => {
			try {
				resolveBody(body ? JSON.parse(body) : {});
			} catch (error) {
				reject(new Error("Request body must be valid JSON."));
			}
		});
		request.on("error", reject);
	});
}

function sendJson(response, status, payload) {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(payload));
}

function numericQuery(value, fallback, min, max) {
	const parsed = Number(value);

	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function openAICommandSchema() {
	return {
		type: "object",
		additionalProperties: false,
		required: ["type", "direction", "pause", "locationText", "placeQuery", "answerStyle", "plan", "raw"],
		properties: {
			type: {
				type: "string",
				enum: ["play", "pause", "next", "prev", "look_direction", "identify_view", "list_nearby_places", "reroute", "create_plan", "freeform"]
			},
			direction: { type: ["string", "null"], enum: ["left", "right", "up", "down", "ahead", "behind", null] },
			pause: { type: "boolean" },
			locationText: { type: ["string", "null"] },
			placeQuery: { type: ["string", "null"] },
			answerStyle: { type: "string", enum: ["brief", "tourist", "historical", "navigation"] },
			raw: { type: "string" },
			plan: {
				type: ["object", "null"],
				additionalProperties: false,
				required: ["originText", "destinationText", "waypoints", "travelMode", "viewMode", "motionQuality", "speedMetersPerSecond", "distance_between_points", "max_points", "prompt", "cameraCues"],
				properties: {
					originText: { type: ["string", "null"] },
					destinationText: { type: ["string", "null"] },
					waypoints: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["name", "purpose", "viewHint", "routeVia"],
							properties: {
								name: { type: "string" },
								purpose: { type: "string" },
								viewHint: { type: "string" },
								routeVia: { type: "boolean" }
							}
						}
					},
					travelMode: { type: "string", enum: ["DRIVING", "BICYCLING", "WALKING"] },
					viewMode: { type: "string", enum: ["follow", "lookat", "free"] },
					motionQuality: { type: "string", enum: ["low", "balanced", "cinematic"] },
					speedMetersPerSecond: { type: ["number", "null"] },
					distance_between_points: { type: ["number", "null"] },
					max_points: { type: ["integer", "null"] },
					prompt: { type: "string" },
					cameraCues: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["from", "to", "label", "lookAtText"],
							properties: {
								from: { type: "number" },
								to: { type: "number" },
								label: { type: "string" },
								lookAtText: { type: ["string", "null"] }
							}
						}
					}
				}
			}
		}
	};
}

function extractOutputText(payload) {
	const chunks = [];

	for (const item of payload.output || []) {
		for (const content of item.content || []) {
			if (content.type === "output_text" && content.text) {
				chunks.push(content.text);
			}
		}
	}
	return chunks.join("").trim();
}

async function handleOpenAIInterpret(request, response, openAIConfig) {
	let body;
	let upstream;
	let text;
	let command;

	if (!openAIConfig) {
		sendJson(response, 501, { error: "OPENAI_API_KEY is not configured; local intent fallback will be used." });
		return;
	}
	if (request.method !== "POST") {
		sendJson(response, 405, { error: "Method not allowed" });
		return;
	}

	body = await readRequestJson(request);
	text = String(body.text || "").trim();
	if (!text) {
		sendJson(response, 400, { error: "Missing text" });
		return;
	}

	upstream = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${openAIConfig.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model: openAIConfig.model,
			input: [
				{
					role: "system",
					content: [{
						type: "input_text",
						text: "You are the Hyperlapse Navigator operator interpreter. Convert an operator voice/chat prompt into one JSON command. Prefer viewer actions for play/pause/look/identify/nearby questions. For tourist questions about a named place, set type to identify_view and set placeQuery to the named place or landmark to search with Google Places, for example 'The Spire'. For directional questions, set direction. Produce create_plan only when the user asks for a new route/tour/journey. For tourist prompts, choose historically or culturally significant waypoints and camera cues, but do not invent exact coordinates; provide place names so the browser can resolve them with Google Geocoding and Routes APIs. Keep facts grounded; Google Places will provide place data before the final guide answer is written."
					}]
				},
				{
					role: "user",
					content: [{
						type: "input_text",
						text: JSON.stringify({ text, context: body.context || {} })
					}]
				}
			],
			text: {
				format: {
					type: "json_schema",
					name: "hyperlapse_operator_command",
					strict: true,
					schema: openAICommandSchema()
				}
			}
		})
	});

	if (!upstream.ok) {
		sendJson(response, upstream.status, { error: `OpenAI Responses API failed with HTTP ${upstream.status}.` });
		return;
	}

	command = JSON.parse(extractOutputText(await upstream.json()));
	command.raw = text;
	sendJson(response, 200, { command });
}

async function handleOpenAIGuideAnswer(request, response, openAIConfig) {
	let body;
	let upstream;
	let text;
	let userContent;

	if (!openAIConfig) {
		sendJson(response, 501, { error: "OPENAI_API_KEY is not configured; local guide formatting will be used." });
		return;
	}
	if (request.method !== "POST") {
		sendJson(response, 405, { error: "Method not allowed" });
		return;
	}

	body = await readRequestJson(request);
	userContent = [{
		type: "input_text",
		text: JSON.stringify({
			question: body.question || "",
			localSelectedPlace: body.localSelectedPlace || body.place || null,
			candidates: body.candidates || [],
			candidateCount: body.candidateCount || 0,
			context: Object.assign({}, body.context || {}, { imageDataUrl: undefined })
		})
	}];
	if (openAIConfig.attachStreetViewImage && body.context && body.context.imageDataUrl) {
		userContent.push({
			type: "input_image",
			image_url: body.context.imageDataUrl
		});
	}
	upstream = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${openAIConfig.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model: openAIConfig.model,
			input: [
				{
					role: "system",
					content: [{
						type: "input_text",
						text: "You are a concise Dublin tourist guide inside a Street View hyperlapse. Use only the supplied Google Places candidates, localSelectedPlace, viewer context, and optional current Street View image. The localSelectedPlace is only a weak geometric guess and may be wrong; do not treat it as authoritative. If an image is supplied, the visible current viewer image is the primary evidence. Choose the supplied candidate that best matches the visible building or landmark, considering candidates from the current, previous, and next route frames when provided. Do not invent a place that is not in the supplied candidates. If no supplied candidate clearly matches the image, say that the visible place is not confidently identified and mention the closest plausible candidates without presenting them as fact. Return 2-4 short sentences suitable for written UI and speech synthesis."
					}]
				},
				{
					role: "user",
					content: userContent
				}
			]
		})
	});

	if (!upstream.ok) {
		sendJson(response, upstream.status, { error: `OpenAI guide answer failed with HTTP ${upstream.status}.` });
		return;
	}

	text = extractOutputText(await upstream.json());
	if (!text) {
		sendJson(response, 502, { error: "OpenAI guide answer returned no text." });
		return;
	}
	sendJson(response, 200, { text });
}

function handleOpenAIConfig(response, openAIConfig) {
	sendJson(response, 200, {
		enabled: !!openAIConfig,
		model: openAIConfig ? openAIConfig.model : null,
		attachStreetViewImage: !!(openAIConfig && openAIConfig.attachStreetViewImage)
	});
}

async function handleStreetViewStatic(request, response, googleApiKey) {
	const requestUrl = new URL(request.url, `http://${host}:${port}`);
	const lat = numericQuery(requestUrl.searchParams.get("lat"), null, -90, 90);
	const lng = numericQuery(requestUrl.searchParams.get("lng"), null, -180, 180);
	const heading = numericQuery(requestUrl.searchParams.get("heading"), 0, 0, 360);
	const pitch = numericQuery(requestUrl.searchParams.get("pitch"), 0, -90, 90);
	const fov = numericQuery(requestUrl.searchParams.get("fov"), 90, 10, 120);
	const size = requestUrl.searchParams.get("size") || "640x320";
	let upstream;
	let body;

	if (request.method !== "GET") {
		sendJson(response, 405, { error: "Method not allowed" });
		return;
	}
	if (lat === null || lng === null || !/^\d{2,4}x\d{2,4}$/.test(size)) {
		sendJson(response, 400, { error: "Missing or invalid Street View Static request parameters." });
		return;
	}

	upstream = await fetch("https://maps.googleapis.com/maps/api/streetview?" + new URLSearchParams({
		key: googleApiKey,
		size,
		location: `${lat},${lng}`,
		heading: String(heading),
		pitch: String(pitch),
		fov: String(fov),
		source: "outdoor"
	}).toString());

	if (!upstream.ok) {
		sendJson(response, upstream.status, { error: `Street View Static API failed with HTTP ${upstream.status}.` });
		return;
	}

	body = Buffer.from(await upstream.arrayBuffer());
	response.writeHead(200, {
		"Content-Type": upstream.headers.get("content-type") || "image/jpeg",
		"Cache-Control": "public, max-age=300"
	});
	response.end(body);
}

function serveStatic(request, response, openAIConfig, googleApiKey) {
	const url = new URL(request.url, `http://${host}:${port}`);
	let pathname = decodeURIComponent(url.pathname);
	let filePath;
	let stat;

	if (pathname === "/api/openai/interpret") {
		handleOpenAIInterpret(request, response, openAIConfig).catch((error) => {
			sendJson(response, 500, { error: error.message });
		});
		return;
	}
	if (pathname === "/api/openai/config") {
		handleOpenAIConfig(response, openAIConfig);
		return;
	}
	if (pathname === "/api/openai/guide-answer") {
		handleOpenAIGuideAnswer(request, response, openAIConfig).catch((error) => {
			sendJson(response, 500, { error: error.message });
		});
		return;
	}
	if (pathname === "/api/google/streetview-static") {
		handleStreetViewStatic(request, response, googleApiKey).catch((error) => {
			sendJson(response, 500, { error: error.message });
		});
		return;
	}

	if (pathname === "/") pathname = "/examples/demo-route.html";
	filePath = normalize(join(root, pathname));

	if (!filePath.startsWith(root + sep) && filePath !== root) {
		sendNotFound(response);
		return;
	}

	if (!existsSync(filePath)) {
		sendNotFound(response);
		return;
	}

	stat = statSync(filePath);
	if (stat.isDirectory()) {
		filePath = join(filePath, "index.html");
		if (!existsSync(filePath)) {
			sendNotFound(response);
			return;
		}
	}

	response.writeHead(200, {
		"Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream"
	});
	createReadStream(filePath).pipe(response);
}

function startServer(openAIConfig, googleApiKey) {
	const server = createServer((request, response) => serveStatic(request, response, openAIConfig, googleApiKey));

	return new Promise((resolveServer, reject) => {
		server.once("error", (error) => {
			if (error.code === "EADDRINUSE") {
				resolveServer(null);
				return;
			}
			reject(error);
		});
		server.listen(port, host, () => {
			resolveServer(server);
		});
	});
}

function openUrl(url) {
	const command = process.platform === "darwin" ? "open" :
		process.platform === "win32" ? "cmd" :
		"xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

	execFile(command, args, { stdio: "ignore" });
}

const fileValues = await loadEnvValues();
const apiKey = await loadApiKey(fileValues);
const openAIConfig = optionalOpenAIConfig(fileValues);
const server = await startServer(openAIConfig, apiKey);
const url = `http://${host}:${port}/examples/demo-route.html?key=${encodeURIComponent(apiKey)}&planUrl=${encodeURIComponent(plan)}`;

if (!noOpen) {
	openUrl(url);
}
console.log(`Hyperlapse demo opened at http://${host}:${port}/examples/demo-route.html with planUrl=${plan}`);
console.log("API key loaded from local environment and intentionally not printed.");
console.log(openAIConfig ? `OpenAI interpreter enabled with model ${openAIConfig.model}. Street View image attachment ${openAIConfig.attachStreetViewImage ? "enabled" : "disabled"}.` : "OpenAI interpreter disabled; using local voice/chat intent fallback.");
if (server) {
	console.log("Press Ctrl+C to stop the local server.");
} else {
	console.log(`Port ${port} is already in use; assuming an existing local server is serving the repo.`);
}

process.on("SIGINT", () => {
	if (!server) process.exit(0);
	server.close(() => process.exit(0));
});
