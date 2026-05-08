import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const defaultPlanPath = join(root, "examples/plans/three-arena-oconnell-street.json");

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

function localEnv() {
	const envPath = join(root, ".env");
	return existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
}

function googleApiKey() {
	const values = localEnv();
	return process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY ||
		values.GOOGLE_MAPS_API_KEY || values.GOOGLE_API_KEY;
}

function openAIKey() {
	const values = localEnv();
	return process.env.OPENAI_API_KEY || values.OPENAI_API_KEY;
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();

		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolvePort(address.port));
		});
	});
}

async function startDemoServer(extraEnv) {
	const port = await freePort();
	const child = spawn("node", ["scripts/launch-demo.mjs", "--no-open"], {
		cwd: root,
		env: {
			...process.env,
			...(extraEnv || {}),
			PORT: String(port),
			HOST: "127.0.0.1"
		},
		stdio: ["ignore", "pipe", "pipe"]
	});
	let output = "";

	child.stdout.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		output += chunk.toString();
	});

	await expect.poll(async () => {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/examples/demo-route.html`);
			return response.status;
		} catch {
			return 0;
		}
	}, {
		message: () => `demo server did not start. Output:\n${output}`,
		timeout: 15000
	}).toBe(200);

	return {
		port,
		baseURL: `http://127.0.0.1:${port}`,
		stop() {
			if (!child.killed) child.kill("SIGINT");
		},
		output() {
			return output;
		}
	};
}

function encodedPlan(plan) {
	return encodeURIComponent(Buffer.from(JSON.stringify(plan), "utf8").toString("base64"));
}

function validationPlan() {
	return {
		origin: { lat: 53.347875, lng: -6.228956 },
		destination: { lat: 53.349164, lng: -6.227734 },
		waypoints: [],
		travelMode: "DRIVING",
		viewMode: "follow",
		motionQuality: "cinematic",
		speedMetersPerSecond: 9,
		distance_between_points: 2,
		max_points: 10,
		millis: 700,
		prompt: "short cinematic Playwright validation route"
	};
}

async function waitForReady(page) {
	await expect.poll(async () => {
		return page.locator("#status").textContent();
	}, {
		timeout: 150000
	}).toMatch(/Ready\. Click play to start the demo route\./);
}

async function expectCanvasHasPixels(page) {
	const pixelCount = await page.evaluate(() => {
		const image = window.hyperlapseDemoApp.hyperlapse.getCurrentImage();
		const context = image && image.getContext && image.getContext("2d");
		const width = image ? image.width : 0;
		const height = image ? image.height : 0;
		const sampleWidth = 12;
		const sampleHeight = 12;
		let pixels;
		let nonBlack = 0;

		if (!context || !width || !height) return 0;
		pixels = context.getImageData(
			Math.max(0, Math.floor(width / 2) - Math.floor(sampleWidth / 2)),
			Math.max(0, Math.floor(height / 2) - Math.floor(sampleHeight / 2)),
			sampleWidth,
			sampleHeight
		).data;
		for (let i = 0; i < pixels.length; i += 4) {
			if (pixels[i] || pixels[i + 1] || pixels[i + 2]) nonBlack++;
		}
		return nonBlack;
	});

	expect(pixelCount).toBeGreaterThan(10);
}

test.describe("Hyperlapse demo route", () => {
	let server;
	let apiKey;

	test.beforeAll(async () => {
		apiKey = googleApiKey();
		test.skip(!apiKey, "GOOGLE_MAPS_API_KEY or GOOGLE_API_KEY is required in .env or the environment.");
		server = await startDemoServer();
	});

	test.afterAll(async () => {
		if (server) server.stop();
	});

	test("default plan stays short and cinematic", async () => {
		const plan = JSON.parse(readFileSync(defaultPlanPath, "utf8"));

		expect(plan.destination).toEqual({ lat: 53.349805, lng: -6.26031 });
		expect(plan.motionQuality).toBe("cinematic");
		expect(plan.max_points).toBeLessThanOrEqual(180);
		expect(plan.distance_between_points).toBeLessThanOrEqual(2);
	});

	test("plays, seeks, looks around, answers a guide prompt, and responds to mobile layout", async ({ page }) => {
		const pageErrors = [];
		const badResponses = [];

		await page.addInitScript(() => {
			class FakeSpeechRecognition {
				constructor() {
					this.continuous = false;
					this.interimResults = false;
					this.lang = "en-US";
					this.onresult = null;
					this.onerror = null;
					this.onend = null;
				}
				start() {
					setTimeout(() => {
						if (this.onresult) {
							this.onresult({
								resultIndex: 0,
								results: [{
									0: { transcript: "turn left" },
									isFinal: true
								}]
							});
						}
					}, 0);
				}
				stop() {
					if (this.onend) this.onend();
				}
			}

			window.SpeechRecognition = FakeSpeechRecognition;
			window.webkitSpeechRecognition = FakeSpeechRecognition;
		});
		await page.route("**/api/openai/interpret", (route) => route.fulfill({
			status: 501,
			contentType: "application/json",
			body: JSON.stringify({ error: "OpenAI disabled for fallback regression test." })
		}));
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("response", (response) => {
			const url = response.url();
			if (response.status() >= 400 && !url.includes("favicon.ico") && !url.includes("/api/openai/")) {
				badResponses.push(`${response.status()} ${url.replace(apiKey, "[KEY]")}`);
			}
		});

		await page.goto(`${server.baseURL}/examples/demo-route.html?key=${encodeURIComponent(apiKey)}&plan=${encodedPlan(validationPlan())}`);
		await expect(page.locator("#route-state")).not.toHaveText("IDLE");
		await waitForReady(page);
		await expect(page.locator("#motion-quality")).toHaveValue("cinematic");
		await expect(page.locator("#timeline")).toBeEnabled();
		await expect(page.locator("#route-map")).toBeVisible();
		await expectCanvasHasPixels(page);
		await expect.poll(() => page.evaluate(() => window.hyperlapseDemoApp.hyperlapse.isPlaying())).toBe(false);
		await expect(page.locator("#player-overlay")).toHaveAttribute("data-state", "ready");
		await expect(page.locator("#player-toggle")).toBeEnabled();
		await expect(page.locator("#player-menu")).toHaveAttribute("aria-expanded", "false");
		await page.locator("#player-menu-button").click();
		await expect(page.locator("#player-menu")).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator("#player-menu-button")).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator("#download-video")).toBeEnabled();
		await page.keyboard.press("Escape");
		await expect(page.locator("#player-menu")).toHaveAttribute("aria-expanded", "false");
		await expect(page.locator("#status")).not.toContainText(/Initializing|Demo initialization failed|Still waiting|Could not load/i);

		const desktopLayout = await page.evaluate(() => {
			const pano = document.getElementById("pano").getBoundingClientRect();
			const controls = document.querySelector(".control-column").getBoundingClientRect();
			return {
				panoLeft: pano.left,
				panoTop: pano.top,
				controlsLeft: controls.left,
				controlsTop: controls.top
			};
		});
		expect(desktopLayout.panoLeft).toBeLessThan(desktopLayout.controlsLeft);
		expect(Math.abs(desktopLayout.panoTop - desktopLayout.controlsTop)).toBeLessThanOrEqual(2);

		await page.evaluate(() => {
			window.__e2eEvents = { seek: 0, look: 0, resize: 0 };
			const h = window.hyperlapseDemoApp.hyperlapse;
			h.addEventListener("seek", () => window.__e2eEvents.seek++);
			h.addEventListener("lookchange", () => window.__e2eEvents.look++);
			h.addEventListener("resize", () => window.__e2eEvents.resize++);
		});

		await page.locator("#player-toggle").click();
		await expect.poll(() => page.evaluate(() => window.hyperlapseDemoApp.hyperlapse.isPlaying())).toBe(true);
		await expect(page.locator("#player-overlay")).toHaveAttribute("data-state", "playing");
		await page.locator("#player-toggle").click();
		await expect.poll(() => page.evaluate(() => window.hyperlapseDemoApp.hyperlapse.isPlaying())).toBe(false);
		await expect(page.locator("#player-overlay")).toHaveAttribute("data-state", "paused");
		await page.locator("#play").click();
		await expect.poll(() => page.evaluate(() => window.hyperlapseDemoApp.hyperlapse.isPlaying())).toBe(true);
		await page.locator("#reverse").click();
		await expect.poll(() => page.evaluate(() => window.hyperlapseDemoApp.hyperlapse.isPlaying())).toBe(true);
		await page.locator("#pause").click();

		const speedValues = await page.evaluate(() => {
			const input = document.getElementById("speed");
			input.value = "0.5";
			input.dispatchEvent(new Event("input", { bubbles: true }));
			const slowMillis = window.hyperlapseDemoApp.hyperlapse.millis;
			input.value = "2";
			input.dispatchEvent(new Event("input", { bubbles: true }));
			const fastMillis = window.hyperlapseDemoApp.hyperlapse.millis;
			return { slowMillis, fastMillis };
		});
		expect(speedValues.slowMillis).toBeGreaterThan(speedValues.fastMillis);

		await page.locator("#travel-mode").selectOption("WALKING");
		await expect(page.locator("#mode-warning")).toContainText("Walking and bicycling routes are beta");
		await expect(page.locator("#apply-route-settings")).toBeEnabled();
		await page.locator("#travel-mode").selectOption("BICYCLING");
		await expect(page.locator("#mode-warning")).toContainText("Walking and bicycling routes are beta");
		await page.locator("#travel-mode").selectOption("DRIVING");
		await expect(page.locator("#mode-warning")).toHaveText("");

		await page.locator("#motion-quality").selectOption("low");
		await expect(page.locator("#motion-quality")).toHaveValue("low");
		await expect(page.locator("#distance-between-points")).toHaveValue("18");
		await page.locator("#motion-quality").selectOption("cinematic");
		await expect(page.locator("#motion-quality")).toHaveValue("cinematic");
		await expect(page.locator("#distance-between-points")).toHaveValue("2");

		await page.locator("#distance-between-points").evaluate((input) => {
			input.value = "3.5";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await expect(page.locator("#distance-between-points-value")).toHaveText("3.5 m");

		await page.evaluate(() => {
			window.__tileReloaded = false;
			window.hyperlapseDemoApp.hyperlapse.load = function() {
				window.__tileReloaded = true;
			};
		});
		await page.locator("#tile-quality").selectOption("3");
		await expect.poll(() => page.evaluate(() => window.hyperlapseDemoApp.hyperlapse.getTileZoom())).toBe(3);
		await expect.poll(() => page.evaluate(() => window.__tileReloaded)).toBe(true);
		await page.evaluate(() => window.hyperlapseDemoApp.setRouteControlsEnabled(true));

		await page.locator("#view-mode").selectOption("lookat");
		await expect(page.locator("#view-mode")).toHaveValue("lookat");
		await page.locator("#view-mode").selectOption("follow");
		await expect(page.locator("#view-mode")).toHaveValue("follow");

		await page.locator("#timeline").evaluate((input) => {
			input.value = String(Math.min(2, Number(input.max)));
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await page.locator("#timeline").dispatchEvent("change");
		const mapMarkerPosition = await page.evaluate(() => {
			var marker = window.hyperlapseDemoApp.routeMarker;
			var position = marker && marker.getPosition();
			return position ? { lat: position.lat(), lng: position.lng() } : null;
		});
		expect(mapMarkerPosition).toEqual(expect.objectContaining({
			lat: expect.any(Number),
			lng: expect.any(Number)
		}));
		const mapClickSeek = await page.evaluate(() => {
			var app = window.hyperlapseDemoApp;
			var before = app.hyperlapse.getPosition();
			var target = app.hyperlapse.getPointAt(Math.min(app.hyperlapse.length() - 1, before + 2)).location;
			var changed = app.seekToClosestFrame(target);
			return {
				changed: changed,
				before: before,
				after: app.hyperlapse.getPosition()
			};
		});
		expect(mapClickSeek.changed).toBe(true);
		expect(mapClickSeek.after).toBeGreaterThanOrEqual(0);
		await page.evaluate(() => {
			window.__runPromptCount = 0;
			window.hyperlapseDemoApp.runPromptPlan = function() {
				window.__runPromptCount++;
			};
		});
		await page.locator("#run-prompt").click();
		await expect.poll(() => page.evaluate(() => window.__runPromptCount)).toBe(1);
		await page.locator("#look-right").click();
		await page.locator("#look-left").click();
		await page.locator("#look-up").click();
		await page.locator("#look-down").click();
		await page.locator("#reset-look").click();
		await page.locator("#pano").focus();
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Home");
		await page.locator("#next").click();
		await page.locator("#prev").click();

		await expect.poll(() => page.evaluate(() => window.__e2eEvents.seek)).toBeGreaterThan(0);
		await expect.poll(() => page.evaluate(() => window.__e2eEvents.look)).toBeGreaterThan(0);
		await expect(page.locator("#view-mode")).toHaveValue("free");

		await page.evaluate(() => {
			window.hyperlapseDemoApp.intentInterpreter._disabled = true;
			window.hyperlapseDemoApp.orchestrator.intentInterpreter._disabled = true;
		});
		await page.locator("#voice-start").click();
		await expect(page.locator("#voice-state")).toHaveText("Listening...");
		await expect(page.locator("#transcript")).toContainText("turn left");
		await expect(page.locator("#voice-action")).toContainText("look_direction left");
		await page.locator("#voice-stop").click();
		await expect(page.locator("#voice-state")).toHaveText("Idle");

		await page.locator("#guide-prompt").fill("what building am I looking at now");
		await page.locator("#guide-form button[type='submit']").click();
		await expect(page.locator("#tour-info")).not.toHaveText("", { timeout: 30000 });
		await expect(page.locator("#tour-info")).not.toContainText(/No named places found/i);

		await page.setViewportSize({ width: 390, height: 844 });
		await expect.poll(() => page.locator("#pano").evaluate((element) => ({
			width: element.clientWidth,
			height: element.clientHeight,
			canvasWidth: element.querySelector("canvas").width,
			canvasHeight: element.querySelector("canvas").height
		}))).toMatchObject({
			width: expect.any(Number),
			height: expect.any(Number),
			canvasWidth: expect.any(Number),
			canvasHeight: expect.any(Number)
		});

		const mobileSize = await page.locator("#pano").evaluate((element) => ({
			width: element.clientWidth,
			height: element.clientHeight,
			canvasWidth: element.querySelector("canvas").width,
			canvasHeight: element.querySelector("canvas").height
		}));
		expect(mobileSize.width).toBeLessThanOrEqual(390);
		expect(mobileSize.canvasWidth).toBe(mobileSize.width);
		expect(mobileSize.canvasHeight).toBe(mobileSize.height);
		const mobileLayout = await page.evaluate(() => {
			const pano = document.getElementById("pano").getBoundingClientRect();
			const controls = document.querySelector(".control-column").getBoundingClientRect();
			return { panoBottom: pano.bottom, controlsTop: controls.top };
		});
		expect(mobileLayout.controlsTop).toBeGreaterThanOrEqual(mobileLayout.panoBottom);

		expect(pageErrors).toEqual([]);
		expect(badResponses).toEqual([]);
	});

	test("has no detectable axe accessibility violations", async ({ page }) => {
		await page.addInitScript(() => {
			window.SpeechRecognition = function() {};
			window.webkitSpeechRecognition = window.SpeechRecognition;
		});
		await page.goto(`${server.baseURL}/examples/demo-route.html?key=${encodeURIComponent(apiKey)}&plan=${encodedPlan(validationPlan())}`);
		await waitForReady(page);

		const results = await new AxeBuilder({ page })
			.exclude("canvas")
			.analyze();

		expect(results.violations).toEqual([]);
	});

	test("attaches the current rendered viewer image to guide formatter requests when enabled", async ({ page }) => {
		let capturedBody = null;

		await page.route("**/api/openai/config", (route) => route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ enabled: true, model: "gpt-5.5", attachStreetViewImage: true })
		}));
		await page.route("**/api/openai/guide-answer", async (route) => {
			capturedBody = route.request().postDataJSON();
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ text: "The visible candidate appears to be The Convention Centre Dublin." })
			});
		});

		await page.goto(`${server.baseURL}/examples/demo-route.html?key=${encodeURIComponent(apiKey)}&plan=${encodedPlan(validationPlan())}`);
		await waitForReady(page);
		await page.evaluate(async () => {
			const app = window.hyperlapseDemoApp;
			const imageDataUrl = app.getCurrentImageDataUrl();

			app.intentInterpreter.attachStreetViewImage = true;
			app.intentInterpreter._configLoaded = true;
			await app.intentInterpreter.formatGuideAnswer("what building am I looking at now?", {
				localSelectedPlace: { name: "Outside In", types: ["art_gallery"] },
				candidates: [
					{ name: "Outside In", types: ["art_gallery"], distanceMeters: 45 },
					{ name: "The Convention Centre Dublin", types: ["convention_center"], distanceMeters: 120 }
				],
				candidateCount: 2
			}, {
				direction: "ahead",
				cameraHeading: 90,
				imageDataUrl
			});
		});

		expect(capturedBody).toEqual(expect.objectContaining({
			question: "what building am I looking at now?",
			localSelectedPlace: expect.objectContaining({ name: "Outside In" }),
			candidates: expect.arrayContaining([
				expect.objectContaining({ name: "The Convention Centre Dublin" })
			])
		}));
		expect(capturedBody.context.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
		expect(capturedBody.context.imageDataUrl.length).toBeGreaterThan(1000);
		expect(capturedBody.context.imageDataUrl.length).toBeLessThan(2 * 1024 * 1024);
	});

	test("OpenAI interpreter endpoint returns a structured command when configured", async ({ request }) => {
		test.skip(!openAIKey(), "OPENAI_API_KEY is required in .env or the environment.");

		const response = await request.post(`${server.baseURL}/api/openai/interpret`, {
			data: {
				text: "turn right and tell me what building I am looking at",
				context: {
					state: "RUNNING",
					position: 1,
					length: 10,
					cameraHeading: 90,
					look: { x: 0, y: 0 },
					location: { lat: 53.347875, lng: -6.228956 },
					currentPlan: validationPlan()
				}
			},
			timeout: 60000
		});
		const body = await response.json();

		expect(response.ok(), JSON.stringify(body)).toBe(true);
		expect(body.command).toEqual(expect.objectContaining({
			type: expect.any(String),
			raw: "turn right and tell me what building I am looking at"
		}));
		expect(["identify_view", "look_direction", "freeform"]).toContain(body.command.type);
	});

	test("OpenAI guide answer endpoint formats grounded Places data when configured", async ({ request }) => {
		test.skip(!openAIKey(), "OPENAI_API_KEY is required in .env or the environment.");

		const response = await request.post(`${server.baseURL}/api/openai/guide-answer`, {
			data: {
				question: "I am looking at the Spire, tell me details about it",
				place: {
					name: "The Spire",
					types: ["tourist_attraction", "point_of_interest"],
					formatted_address: "O'Connell Street Upper, Dublin, Ireland",
					rating: 4.3,
					user_ratings_total: 12000
				},
				candidates: [
					{
						name: "Fibber Magees",
						types: ["event_venue"],
						formatted_address: "Dublin, Ireland",
						distanceMeters: 42
					},
					{
						name: "The Spire",
						types: ["tourist_attraction", "point_of_interest"],
						formatted_address: "O'Connell Street Upper, Dublin, Ireland",
						distanceMeters: 90
					}
				],
				candidateCount: 1,
				context: {
					direction: "named",
					location: { lat: 53.3498, lng: -6.2603 }
				}
			},
			timeout: 60000
		});
		const body = await response.json();

		expect(response.ok(), JSON.stringify(body)).toBe(true);
		expect(body.text).toMatch(/Spire/i);
		expect(body.text).not.toMatch(/Fibber/i);
	});

	test("OpenAI config can enable current Street View image attachment", async ({ request }) => {
		const imageServer = await startDemoServer({ OPENAI_GUIDE_ATTACH_STREETVIEW_IMAGE: "true" });

		try {
			const response = await request.get(`${imageServer.baseURL}/api/openai/config`);
			const body = await response.json();

			expect(response.ok(), JSON.stringify(body)).toBe(true);
			expect(body.attachStreetViewImage).toBe(true);
		} finally {
			imageServer.stop();
		}
	});
});
