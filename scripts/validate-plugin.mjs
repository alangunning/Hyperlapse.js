import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file}: ${error.message}`);
    return null;
  }
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

const pluginRoot = "plugins/hyperlapse-navigator";
const manifestPath = path.join(root, pluginRoot, ".codex-plugin", "plugin.json");
const manifest = readJson(manifestPath);

if (!manifest) process.exit();

if (manifest.name !== "hyperlapse-navigator") {
  fail(`${pluginRoot}/.codex-plugin/plugin.json: name must be hyperlapse-navigator`);
}

if (manifest.skills !== "./skills/") {
  fail(`${pluginRoot}/.codex-plugin/plugin.json: skills must point to ./skills/`);
}

if (!manifest.interface || !manifest.interface.displayName || !manifest.interface.defaultPrompt) {
  fail(`${pluginRoot}/.codex-plugin/plugin.json: interface.displayName and interface.defaultPrompt are required`);
}

if (manifest.interface && manifest.interface.defaultPrompt && manifest.interface.defaultPrompt.length > 3) {
  fail(`${pluginRoot}/.codex-plugin/plugin.json: interface.defaultPrompt must contain at most 3 prompts`);
}

const skillPath = "plugins/hyperlapse-navigator/skills/hyperlapse-orchestrator/SKILL.md";
const agentPaths = [
  {
    path: ".codex/agents/hyperlapse_orchestrator.toml",
    name: "hyperlapse_orchestrator",
    sandbox: "read-only",
    requiredText: "Required workflow:"
  },
  {
    path: ".codex/agents/hyperlapse_plan_writer.toml",
    name: "hyperlapse_plan_writer",
    sandbox: "workspace-write",
    requiredText: "Detailed plan responsibilities:"
  },
  {
    path: ".codex/agents/hyperlapse_runner.toml",
    name: "hyperlapse_runner",
    sandbox: "read-only",
    requiredText: "Read-only validation workflow:"
  }
];
const marketplacePath = ".agents/plugins/marketplace.json";
const projectConfigPath = ".codex/config.toml";
const samplePlanPath = "examples/plans/three-arena-heuston-history.json";
const launcherPath = "scripts/launch-demo.mjs";
const envExamplePath = ".env.example";
const roadmapPath = "docs/AI_TOUR_GUIDE_ROADMAP.md";

if (!exists(skillPath)) fail(`${skillPath}: missing`);
for (const agent of agentPaths) {
  if (!exists(agent.path)) fail(`${agent.path}: missing`);
}
if (!exists(marketplacePath)) fail(`${marketplacePath}: missing`);
if (!exists(projectConfigPath)) fail(`${projectConfigPath}: missing`);
if (!exists(samplePlanPath)) fail(`${samplePlanPath}: missing`);
if (!exists(launcherPath)) fail(`${launcherPath}: missing`);
if (!exists(envExamplePath)) fail(`${envExamplePath}: missing`);
if (!exists(roadmapPath)) fail(`${roadmapPath}: missing`);

if (exists(skillPath)) {
  const skill = fs.readFileSync(path.join(root, skillPath), "utf8");
  if (!skill.startsWith("---\n")) fail(`${skillPath}: missing YAML frontmatter`);
  if (!/^name: hyperlapse-orchestrator$/m.test(skill)) fail(`${skillPath}: missing expected skill name`);
  if (!/^description: .+/m.test(skill)) fail(`${skillPath}: missing description`);
  for (const required of ["Agent Roles", "Role Playbooks", "Orchestrator", "Plan Writer", "Runner", "read-only coordinator", "Do not generate detailed `JourneyPlan` JSON", "JourneyPlan", "VoiceOrchestrator", "TourGuide", "RoutesAdapter", "Chrome/CDP", "WALKING", "BICYCLING", "cameraCues", "planUrl", "npm run demo:route"]) {
    if (!skill.includes(required)) fail(`${skillPath}: missing ${required} guidance`);
  }
}

for (const expected of agentPaths) {
  if (exists(expected.path)) {
    const agent = fs.readFileSync(path.join(root, expected.path), "utf8");
    if (!new RegExp(`^name = "${expected.name}"$`, "m").test(agent)) {
      fail(`${expected.path}: missing expected agent name`);
    }
    if (!new RegExp(`^sandbox_mode = "${expected.sandbox}"$`, "m").test(agent)) {
      fail(`${expected.path}: sandbox_mode must be ${expected.sandbox}`);
    }
    if (!agent.includes(`read and follow ${skillPath}`)) {
      fail(`${expected.path}: developer_instructions must point to the skill`);
    }
    if (!agent.includes(expected.requiredText)) {
      fail(`${expected.path}: missing ${expected.requiredText} handoff guidance`);
    }
    if (expected.name === "hyperlapse_orchestrator") {
      for (const required of ["hyperlapse_plan_writer", "hyperlapse_runner", "Do not write to the workspace", "Handoff format to the plan writer", "Handoff format to the runner", "plan writer owns detailed coordinates"]) {
        if (!agent.includes(required)) fail(`${expected.path}: missing ${required} coordinator guidance`);
      }
    }
    if (expected.name === "hyperlapse_plan_writer") {
      for (const required of ["Allowed writes", "examples/plans/", "Never write API keys", "Before final response"]) {
        if (!agent.includes(required)) fail(`${expected.path}: missing ${required} plan-writer guidance`);
      }
    }
    if (expected.name === "hyperlapse_runner") {
      for (const required of ["Do not edit files", "canvas", "network", "Failure handling"]) {
        if (!agent.includes(required)) fail(`${expected.path}: missing ${required} runner guidance`);
      }
    }
    if (!/\[\[skills\.config\]\]/m.test(agent)) {
      fail(`${expected.path}: missing skills.config block`);
    }
    if (!/^path = "plugins\/hyperlapse-navigator\/skills\/hyperlapse-orchestrator\/SKILL.md"$/m.test(agent)) {
      fail(`${expected.path}: skills.config path must point to the skill`);
    }
    if (!/^enabled = true$/m.test(agent)) {
      fail(`${expected.path}: skills.config must enable the skill`);
    }
  }
}

if (exists(samplePlanPath)) {
  const plan = readJson(path.join(root, samplePlanPath));
  if (plan) {
    if (!plan.origin || !plan.destination) fail(`${samplePlanPath}: origin and destination are required`);
    if (plan.travelMode !== "DRIVING") fail(`${samplePlanPath}: travelMode should be DRIVING`);
    if (plan.viewMode !== "follow") fail(`${samplePlanPath}: viewMode should be follow`);
    if (!Array.isArray(plan.waypoints) || plan.waypoints.length < 3) {
      fail(`${samplePlanPath}: expected at least 3 waypoints`);
    }
    if (!Array.isArray(plan.cameraCues) || plan.cameraCues.length < 3) {
      fail(`${samplePlanPath}: expected at least 3 camera cues`);
    }
    for (const [index, cue] of (plan.cameraCues || []).entries()) {
      if (typeof cue.from !== "number" || typeof cue.to !== "number" || cue.from < 0 || cue.to > 1 || cue.from > cue.to) {
        fail(`${samplePlanPath}: cameraCues[${index}] must use ordered normalized from/to values`);
      }
      if (!cue.lookat || typeof cue.lookat.lat !== "number" || typeof cue.lookat.lng !== "number") {
        fail(`${samplePlanPath}: cameraCues[${index}] must include numeric lookat coordinates`);
      }
    }
  }
}

if (exists(marketplacePath)) {
  const marketplace = readJson(path.join(root, marketplacePath));
  const entry = marketplace && marketplace.plugins && marketplace.plugins.find((plugin) => plugin.name === "hyperlapse-navigator");
  if (!entry) fail(`${marketplacePath}: missing hyperlapse-navigator entry`);
  if (entry && (!entry.source || entry.source.path !== "./plugins/hyperlapse-navigator")) {
    fail(`${marketplacePath}: hyperlapse-navigator source.path must be ./plugins/hyperlapse-navigator`);
  }
  if (entry && (!entry.policy || entry.policy.installation !== "INSTALLED_BY_DEFAULT" || entry.policy.authentication !== "ON_USE")) {
    fail(`${marketplacePath}: hyperlapse-navigator policy must activate by default and authenticate on use`);
  }
}

if (exists(projectConfigPath)) {
  const config = fs.readFileSync(path.join(root, projectConfigPath), "utf8");
  if (!/\[plugins\."hyperlapse-navigator@hyperlapse-local"\]\nenabled = true/m.test(config)) {
    fail(`${projectConfigPath}: missing enabled hyperlapse-navigator plugin entry`);
  }
  if (!/\[marketplaces\.hyperlapse-local\]\nsource_type = "local"\nsource = "\/Users\/alangunning\/Projects-Airnub-Labs\/Hyperlapse\.js"/m.test(config)) {
    fail(`${projectConfigPath}: missing hyperlapse-local marketplace source`);
  }
}

if (exists(launcherPath)) {
  const launcher = fs.readFileSync(path.join(root, launcherPath), "utf8");
  for (const required of ["GOOGLE_MAPS_API_KEY", "GOOGLE_API_KEY", "API key loaded from local environment and intentionally not printed", "EADDRINUSE", "planUrl"]) {
    if (!launcher.includes(required)) fail(`${launcherPath}: missing ${required}`);
  }
}

if (exists(envExamplePath)) {
  const envExample = fs.readFileSync(path.join(root, envExamplePath), "utf8");
  if (!/^GOOGLE_MAPS_API_KEY=YOUR_GOOGLE_MAPS_API_KEY$/m.test(envExample)) {
    fail(`${envExamplePath}: missing GOOGLE_MAPS_API_KEY placeholder`);
  }
}

if (exists(roadmapPath)) {
  const roadmap = fs.readFileSync(path.join(root, roadmapPath), "utf8");
  for (const required of ["AI Intent Layer", "Realtime Voice", "Place Prefetching", "Codex-Generated Tour Assets", "Shareable Demo"]) {
    if (!roadmap.includes(required)) fail(`${roadmapPath}: missing ${required}`);
  }
}

if (!process.exitCode) {
  console.log("Plugin structure validation passed.");
}
