import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 180000,
	expect: {
		timeout: 15000
	},
	fullyParallel: false,
	reporter: [["list"]],
	use: {
		trace: "retain-on-failure",
		video: "retain-on-failure",
		screenshot: "only-on-failure"
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] }
		}
	]
});
