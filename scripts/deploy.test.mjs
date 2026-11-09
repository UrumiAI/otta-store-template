// Tests for scripts/deploy.mjs. They run the real script against fake `emdash`
// and `wrangler` executables on PATH, so nothing touches Cloudflare:
//   node --test scripts/deploy.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "otta-deploy-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const TOKEN = "cf-test-token-value-do-not-print-1234567890";
const ENCRYPTION_KEY = "emdash_enc_v1_never-print-this-either";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const FINGERPRINT = "ab".repeat(32);
const REAL_DB_ID = "12345678-1234-4234-8234-123456789012";
const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";
const PENDING = ["001_initial", "002_media_status", "091_redirect_artifacts"];

// One fake program, installed as both `emdash` and `wrangler`. It appends each
// call to FAKE_CALLS and behaves as the state file in FAKE_STATE says.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify([tool, ...args]) + "\\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const leak = () => {
	if (!state.leak) return;
	console.error("leak on stderr " + process.env.CLOUDFLARE_API_TOKEN + " " + process.env.EMDASH_ENCRYPTION_KEY);
};
const report = () => ({
	target: { kind: "d1", label: "acct/db/id", fingerprint: state.fingerprint },
	knownApplied: state.applied,
	pending: state.pending,
	unknownApplied: state.unknownApplied,
	executed: [],
	...(state.lock ? { lock: state.lock } : {}),
});
if (tool === "wrangler") {
	if (args[0] === "whoami") {
		leak();
		if (state.whoamiExit) { console.error("whoami failed"); process.exit(state.whoamiExit); }
		console.log(JSON.stringify({ loggedIn: true, accounts: state.accounts }));
		process.exit(0);
	}
	if (args[0] === "deploy") {
		console.log("fake wrangler deployed");
		process.exit(state.deployExit ?? 0);
	}
	console.error("unexpected wrangler call");
	process.exit(99);
}
leak();
if (args.includes("--status")) {
	if (state.statusExit) { console.error("status failed"); process.exit(state.statusExit); }
	console.log(JSON.stringify(report()));
	process.exit(0);
}
if (args.includes("--check")) {
	if (state.checkExit !== undefined) { console.log(JSON.stringify(report())); process.exit(state.checkExit); }
	const code = state.unknownApplied.length ? 3 : state.pending.length ? 2 : 0;
	console.log(JSON.stringify(report()));
	process.exit(code);
}
// apply
const fp = args[args.indexOf("--expected-target-fingerprint") + 1];
if (!args.includes("--expected-target-fingerprint") || fp !== state.fingerprint) {
	console.error("Noninteractive apply requires --expected-target-fingerprint");
	process.exit(4);
}
if (state.applyExit) { console.error("apply failed part-way"); process.exit(state.applyExit); }
const executed = state.pending;
state.applied = [...state.applied, ...state.pending];
state.pending = [];
state.lock = null;
save();
console.log(JSON.stringify({ ...report(), executed }));
process.exit(0);
`;

const WRANGLER_JSONC = (dbId, extra = "") => `// a comment with "database_id": "11111111-1111-1111-1111-111111111111"
{
	"name": "otta-store", // trailing comment
	${extra}
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "otta-store-db",
			"database_id": "${dbId}",
		},
	],
	/* block comment */
}
`;

function defaultState(overrides = {}) {
	return {
		fingerprint: FINGERPRINT,
		applied: [],
		pending: PENDING,
		unknownApplied: [],
		lock: null,
		accounts: [{ id: ACCOUNT, name: "only" }],
		...overrides,
	};
}

let counter = 0;

function runDeploy({
	state: stateOverrides,
	env = {},
	args = [],
	databaseId = REAL_DB_ID,
	wranglerExtra = "",
	manifest = true,
	omit = [],
} = {}) {
	const project = join(scratch, `p${++counter}`);
	const bin = join(project, ".fakebin");
	mkdirSync(join(project, "scripts"), { recursive: true });
	mkdirSync(bin);
	copyFileSync(join(here, "deploy.mjs"), join(project, "scripts", "deploy.mjs"));
	writeFileSync(join(project, "package.json"), '{"name":"t"}');
	writeFileSync(join(project, "wrangler.jsonc"), WRANGLER_JSONC(databaseId, wranglerExtra));
	if (manifest) {
		mkdirSync(join(project, ".emdash"));
		writeFileSync(
			join(project, ".emdash", "migrations.json"),
			JSON.stringify({ database: { executorConfig: { binding: "DB" } } }),
		);
	}
	for (const name of ["emdash", "wrangler"]) {
		const file = join(bin, name);
		writeFileSync(file, FAKE);
		chmodSync(file, 0o755);
	}
	const statePath = join(project, "fake-state.json");
	const callsPath = join(project, "fake-calls.jsonl");
	writeFileSync(statePath, JSON.stringify(defaultState(stateOverrides)));
	writeFileSync(callsPath, "");

	// PATH holds only the fakes and the directory of node itself, so a real
	// `wrangler` can never be reached from a test.
	const childEnv = {
		PATH: `${bin}:${dirname(process.execPath)}`,
		FAKE_STATE: statePath,
		FAKE_CALLS: callsPath,
		CLOUDFLARE_API_TOKEN: TOKEN,
		CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
		EMDASH_ENCRYPTION_KEY: ENCRYPTION_KEY,
		...env,
	};
	for (const name of omit) delete childEnv[name];

	const result = spawnSync(process.execPath, [join(project, "scripts", "deploy.mjs"), ...args], {
		cwd: project,
		env: childEnv,
		encoding: "utf8",
	});
	const calls = readFileSync(callsPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	return {
		code: result.status,
		output: `${result.stdout}${result.stderr}`,
		calls,
		steps: calls.map(label),
		state: JSON.parse(readFileSync(statePath, "utf8")),
		project,
	};
}

function label(call) {
	const [tool, ...args] = call;
	if (tool === "wrangler") return args[0] === "whoami" ? "whoami" : "deploy";
	if (args.includes("--status")) return "status";
	if (args.includes("--check")) return "check";
	return "apply";
}

const flagValue = (call, flag) => call[call.indexOf(flag) + 1];
const ago = (minutes) => {
	const heldSince = Date.now() - minutes * 60_000;
	return { id: String(heldSince), heldSince: new Date(heldSince).toISOString() };
};

describe("first deploy and later pushes", () => {
	test("fresh database: applies with the fingerprint, checks, then deploys", () => {
		const run = runDeploy();
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "apply", "check", "deploy"]);
		const apply = run.calls[1];
		assert.equal(flagValue(apply, "--expected-target-fingerprint"), FINGERPRINT);
		assert.ok(!apply.includes("--take-over-lock"));
		assert.equal(flagValue(apply, "--wrangler-config"), "wrangler.jsonc");
		assert.equal(flagValue(apply, "--account-id"), ACCOUNT);
		assert.deepEqual(run.state.pending, []);
	});

	test("nothing pending: no apply, still checks, then deploys", () => {
		const run = runDeploy({ state: { pending: [], applied: PENDING } });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "check", "deploy"]);
	});

	test("wrangler deploy is run with exactly the arguments the template used", () => {
		const run = runDeploy();
		assert.deepEqual(run.calls.at(-1), ["wrangler", "deploy"]);
	});

	test("deploy exit code is propagated", () => {
		const run = runDeploy({ state: { deployExit: 7 } });
		assert.equal(run.code, 7, run.output);
		assert.equal(run.steps.at(-1), "deploy");
	});

	test("--migrate-only stops after the final check", () => {
		const run = runDeploy({ args: ["--migrate-only"] });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "apply", "check"]);
	});

	test("an unknown argument is refused before anything runs", () => {
		const run = runDeploy({ args: ["--dry-run"] });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /--dry-run/);
	});
});

describe("migration lock", () => {
	test("stale lock (older than 15 minutes) is taken over", () => {
		const lock = ago(20);
		const run = runDeploy({ state: { lock } });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "apply", "check", "deploy"]);
		assert.equal(flagValue(run.calls[1], "--take-over-lock"), lock.id);
		assert.equal(flagValue(run.calls[1], "--expected-target-fingerprint"), FINGERPRINT);
	});

	test("fresh lock with pending migrations is refused, nothing applied or deployed", () => {
		const run = runDeploy({ state: { lock: ago(3) } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
		assert.match(run.output, /retry/i);
		assert.match(run.output, /15 minutes/);
	});

	test("lock just under the threshold is still refused", () => {
		const run = runDeploy({ state: { lock: ago(14.5) } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
	});

	test("a lock with an unreadable time is treated as fresh", () => {
		const run = runDeploy({ state: { lock: { id: "12345", heldSince: "garbage" } } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
	});

	test("stale lock with nothing pending is released, then deploys", () => {
		const lock = ago(60);
		const run = runDeploy({ state: { lock, pending: [], applied: PENDING } });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "apply", "check", "deploy"]);
		assert.equal(flagValue(run.calls[1], "--take-over-lock"), lock.id);
	});

	test("fresh lock with nothing pending does not block the deploy", () => {
		const run = runDeploy({ state: { lock: ago(1), pending: [], applied: PENDING } });
		assert.equal(run.code, 0, run.output);
		assert.deepEqual(run.steps, ["status", "check", "deploy"]);
	});
});

describe("failures stop before deploy", () => {
	test("migrate failure stops before deploy with a plain message", () => {
		const run = runDeploy({ state: { applyExit: 1 } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "apply"]);
		assert.match(run.output, /Retry/);
		assert.match(run.output, /not deployed|Nothing was deployed/i);
	});

	test("final check failure stops before deploy", () => {
		const run = runDeploy({ state: { checkExit: 2 } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status", "apply", "check"]);
	});

	test("status failure stops before anything else", () => {
		const run = runDeploy({ state: { statusExit: 1 } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
	});

	test("unknown applied migrations are refused", () => {
		const run = runDeploy({ state: { unknownApplied: ["999_future"], pending: [] } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
		assert.match(run.output, /newer/i);
	});

	test("a malformed fingerprint from status is refused", () => {
		const run = runDeploy({ state: { fingerprint: "nope" } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["status"]);
	});
});

describe("preflight refusals", () => {
	test("placeholder database id is refused without touching anything", () => {
		const run = runDeploy({ databaseId: PLACEHOLDER_DB_ID });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /placeholder/i);
		assert.match(run.output, /database_id/);
	});

	test("a non-UUID database id is refused", () => {
		const run = runDeploy({ databaseId: "your-database-id" });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
	});

	test("missing token: names the variable, where to set it, and stops", () => {
		const run = runDeploy({ omit: ["CLOUDFLARE_API_TOKEN"] });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /CLOUDFLARE_API_TOKEN/);
		assert.match(run.output, /D1/);
	});

	test("missing token inside Workers Builds says so", () => {
		const run = runDeploy({ omit: ["CLOUDFLARE_API_TOKEN"], env: { WORKERS_CI: "1" } });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /Build/);
	});

	test("missing build manifest asks for npm run build", () => {
		const run = runDeploy({ manifest: false });
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, []);
		assert.match(run.output, /npm run build/);
	});
});

describe("account id", () => {
	test("CLOUDFLARE_ACCOUNT_ID is used without calling whoami", () => {
		const run = runDeploy();
		assert.equal(run.code, 0, run.output);
		assert.ok(!run.steps.includes("whoami"));
	});

	test("account_id in wrangler.jsonc is used without calling whoami", () => {
		const configured = "fedcba9876543210fedcba9876543210";
		const run = runDeploy({
			omit: ["CLOUDFLARE_ACCOUNT_ID"],
			wranglerExtra: `"account_id": "${configured}",`,
		});
		assert.equal(run.code, 0, run.output);
		assert.ok(!run.steps.includes("whoami"));
		assert.equal(flagValue(run.calls[0], "--account-id"), configured);
	});

	test("falls back to the single account wrangler can see", () => {
		const run = runDeploy({ omit: ["CLOUDFLARE_ACCOUNT_ID"] });
		assert.equal(run.code, 0, run.output);
		assert.equal(run.steps[0], "whoami");
		assert.equal(flagValue(run.calls[1], "--account-id"), ACCOUNT);
	});

	test("several accounts: refused, because guessing could hit the wrong store", () => {
		const run = runDeploy({
			omit: ["CLOUDFLARE_ACCOUNT_ID"],
			state: {
				accounts: [
					{ id: ACCOUNT, name: "a" },
					{ id: "fedcba9876543210fedcba9876543210", name: "b" },
				],
			},
		});
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["whoami"]);
		assert.match(run.output, /CLOUDFLARE_ACCOUNT_ID/);
	});

	test("whoami failure names the variable to set", () => {
		const run = runDeploy({
			omit: ["CLOUDFLARE_ACCOUNT_ID"],
			state: { whoamiExit: 1 },
		});
		assert.notEqual(run.code, 0);
		assert.deepEqual(run.steps, ["whoami"]);
		assert.match(run.output, /CLOUDFLARE_ACCOUNT_ID/);
	});
});

describe("secrets", () => {
	const assertClean = (run) => {
		assert.ok(!run.output.includes(TOKEN), "token printed");
		assert.ok(!run.output.includes(ENCRYPTION_KEY), "encryption key printed");
		for (const call of run.calls) {
			assert.ok(!call.join(" ").includes(TOKEN), "token passed as an argument");
		}
	};

	test("secrets echoed by a tool never reach the build log", () => {
		const run = runDeploy({ state: { leak: true } });
		assert.equal(run.code, 0, run.output);
		assert.match(run.output, /leak on stderr/);
		assertClean(run);
	});

	test("secrets echoed on a failed apply never reach the build log", () => {
		const run = runDeploy({ state: { leak: true, applyExit: 1 } });
		assert.notEqual(run.code, 0);
		assertClean(run);
	});

	test("secrets echoed by whoami never reach the build log", () => {
		const run = runDeploy({ omit: ["CLOUDFLARE_ACCOUNT_ID"], state: { leak: true, whoamiExit: 1 } });
		assert.notEqual(run.code, 0);
		assertClean(run);
	});
});
