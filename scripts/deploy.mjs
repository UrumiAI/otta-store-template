#!/usr/bin/env node
// `npm run deploy`: apply the store's database migrations from the build, then
// run `wrangler deploy`.
//
// Why here and not in the Worker: a new database needs 90 migrations, and a
// Worker on the Free plan is cut off long before it finishes one first start
// (seen: 34 of 90, then a 503 forever because the cut-off run never released
// its lock). Migrations started from a build have no such limit.
//
// Order: migrate, check, deploy.
// - A first deploy never leaves a Worker in front of an unmigrated database,
//   because deploy only runs after the check passes.
// - On later pushes the Worker still running is unaffected: it counts applied
//   migrations and, seeing at least as many as it knows, skips migrating. If
//   the Worker were deployed first it would apply them itself, in the same
//   limits this script exists to avoid, on a store with real orders.
//   EmDash documents this order (migrate, deploy, check) and writes its core
//   migrations to be compatible with old and new code during a deploy.
//
// Uses only Node built-ins and the `emdash` and `wrangler` that `npm run`
// puts on PATH. Secrets stay in the environment, never in arguments, and
// anything a tool prints is scrubbed of them before it reaches the build log.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG = "wrangler.jsonc";
const MANIFEST = join(root, ".emdash", "migrations.json");
// A held lock younger than this may belong to a run that is still working. A
// Worker cannot run this long, and a migrate job takes minutes.
const LOCK_TAKEOVER_AGE_MS = 15 * 60 * 1000;
const NOT_DEPLOYED =
	"Nothing was deployed: a new store stays offline, and a running store keeps its current version.";
const RETRY = "Retry the build from your Worker's build history in the Cloudflare dashboard, or push a new commit.";

class Stop extends Error {}

const log = (message) => console.log(`[otta-deploy] ${message}`);
const stop = (...lines) => {
	throw new Stop(lines.join("\n"));
};

// Every environment value that looks like a credential, longest first, so a
// value that contains another is replaced whole.
const secrets = Object.entries(process.env)
	.filter(([name, value]) => /token|secret|key|password|credential/i.test(name) && value?.length >= 8)
	.map(([, value]) => value)
	.sort((a, b) => b.length - a.length);

function scrub(text) {
	let clean = text;
	for (const secret of secrets) clean = clean.replaceAll(secret, "[redacted]");
	return clean;
}

// Runs a tool without a terminal. stderr is forwarded line by line, scrubbed;
// stdout is returned to the caller and never printed as it arrives.
function run(command, args) {
	return new Promise((done) => {
		const child = spawn(command, args, {
			cwd: root,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		let stdout = "";
		let partial = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			const lines = (partial + chunk).split("\n");
			partial = lines.pop();
			for (const line of lines) console.error(scrub(line));
		});
		child.on("error", (error) => {
			console.error(scrub(`Could not start ${command}: ${error.message}`));
			done({ code: 127, stdout: "" });
		});
		child.on("close", (code) => {
			if (partial) console.error(scrub(partial));
			done({ code: code ?? 1, stdout });
		});
	});
}

function parseJson(stdout) {
	try {
		return JSON.parse(stdout.slice(stdout.indexOf("{")));
	} catch {
		return undefined;
	}
}

// wrangler.jsonc allows comments and trailing commas; JSON.parse does not.
function parseJsonc(source) {
	let out = "";
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === '"') {
			const start = i;
			for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === "\\") i++;
			out += source.slice(start, i + 1);
		} else if (char === "/" && source[i + 1] === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			out += "\n";
		} else if (char === "/" && source[i + 1] === "*") {
			i = source.indexOf("*/", i + 2) + 1;
			if (i === 0) i = source.length;
		} else {
			out += char;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readConfig(binding) {
	let config;
	try {
		config = parseJsonc(readFileSync(join(root, WRANGLER_CONFIG), "utf8"));
	} catch {
		stop(`${WRANGLER_CONFIG} could not be read. Fix the file and push again.`, NOT_DEPLOYED);
	}
	const database = (config.d1_databases ?? []).find((entry) => entry.binding === binding);
	const id = database?.database_id;
	const placeholder = /^0{8}-0{4}-0{4}-0{4}-0{12}$|^f{8}-f{4}-f{4}-f{4}-f{12}$/i;
	const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
	if (typeof id !== "string" || !uuid.test(id) || placeholder.test(id)) {
		stop(
			`The "${binding}" database in ${WRANGLER_CONFIG} has no real database_id (found: ${id ?? "none"}; a placeholder or missing id).`,
			"The Deploy to Cloudflare button normally writes the real id into your copy of this file.",
			`Create the D1 database in the Cloudflare dashboard, put its database_id in ${WRANGLER_CONFIG}, and push.`,
			NOT_DEPLOYED,
		);
	}
	return config;
}

async function resolveAccountId(config) {
	const valid = /^[a-f0-9]{32}$/i;
	for (const candidate of [config.account_id, process.env.CLOUDFLARE_ACCOUNT_ID]) {
		if (candidate) {
			if (!valid.test(candidate)) {
				stop("The Cloudflare account id is not a 32-character id. Fix CLOUDFLARE_ACCOUNT_ID or account_id.", NOT_DEPLOYED);
			}
			return candidate;
		}
	}
	const fix = `Add a build variable named CLOUDFLARE_ACCOUNT_ID, set to your Cloudflare account id (your Worker > Settings > Build > Variables), then retry.`;
	const { code, stdout } = await run("wrangler", ["whoami", "--json"]);
	const accounts = code === 0 ? parseJson(stdout)?.accounts : undefined;
	if (!Array.isArray(accounts) || accounts.length === 0) {
		stop("Could not work out which Cloudflare account this store belongs to.", fix, NOT_DEPLOYED);
	}
	if (accounts.length > 1) {
		stop(
			`This token can see ${accounts.length} Cloudflare accounts, so this script will not guess which one holds your database.`,
			fix,
			NOT_DEPLOYED,
		);
	}
	const { id } = accounts[0];
	if (!valid.test(id ?? "")) stop("Cloudflare returned an unexpected account id.", fix, NOT_DEPLOYED);
	return id;
}

async function emdashReport(args) {
	const { code, stdout } = await run("emdash", ["migrate", ...args]);
	return { code, report: parseJson(stdout), stdout };
}

function lockAgeMs(lock) {
	const age = Date.now() - Date.parse(lock.heldSince);
	return Number.isFinite(age) ? age : 0;
}

async function migrate(accountId) {
	const target = ["--wrangler-config", WRANGLER_CONFIG, "--account-id", accountId];

	log("Reading the database's migration status...");
	const status = await emdashReport([...target, "--status", "--json"]);
	if (status.code !== 0) {
		stop(
			"Could not read the store database's migration status (see the message above).",
			"If it mentions permissions or a missing database, the build's API token cannot reach this D1 database.",
			RETRY,
			NOT_DEPLOYED,
		);
	}
	const { report } = status;
	const fingerprint = report?.target?.fingerprint;
	if (
		!/^[a-f0-9]{64}$/.test(fingerprint ?? "") ||
		!Array.isArray(report.pending) ||
		!Array.isArray(report.unknownApplied)
	) {
		stop("The migration status could not be understood, so this script will not change the database.", RETRY, NOT_DEPLOYED);
	}
	if (report.unknownApplied.length > 0) {
		stop(
			`The database has migrations this build does not know (${report.unknownApplied.join(", ")}), so it is newer than this build or belongs to another store.`,
			"Update the Otta packages to at least the version that last deployed, or check that wrangler.jsonc points at the right database.",
			NOT_DEPLOYED,
		);
	}

	const pending = report.pending.length;
	log(`${report.knownApplied?.length ?? 0} migrations already applied, ${pending} pending.`);

	let takeOver;
	if (report.lock) {
		const minutes = Math.floor(lockAgeMs(report.lock) / 60000);
		if (lockAgeMs(report.lock) > LOCK_TAKEOVER_AGE_MS) {
			log(`Taking over a migration lock left behind ${minutes} minutes ago.`);
			takeOver = report.lock.id;
		} else if (pending > 0) {
			stop(
				`Another run took the database's migration lock ${minutes} minute(s) ago, so migrations were not started.`,
				"It is either still running, or it was cut off.",
				`Wait until the lock is 15 minutes old. ${RETRY} A later build takes the lock over if it is still held.`,
				NOT_DEPLOYED,
			);
		} else {
			log("A migration lock is held, but nothing is pending, so it does not affect this deploy.");
		}
	}

	if (pending > 0 || takeOver) {
		log(pending > 0 ? `Applying ${pending} migrations. This can take a few minutes...` : "Releasing the stale lock...");
		const args = [...target, "--json", "--expected-target-fingerprint", fingerprint];
		if (takeOver) args.push("--take-over-lock", takeOver);
		const applied = await emdashReport(args);
		if (applied.code !== 0) {
			if (applied.stdout) console.error(scrub(applied.stdout));
			stop(
				"Applying the database migrations failed (see the message above).",
				"Completed migrations are kept and the next attempt continues after them; do not delete the database.",
				`${RETRY} If it fails the same way again, get help before retrying and include this log.`,
				NOT_DEPLOYED,
			);
		}
		log(pending > 0 ? `Applied ${applied.report?.executed?.length ?? pending} migrations.` : "Lock released.");
	}

	const check = await emdashReport([...target, "--check", "--json"]);
	if (check.code !== 0) {
		stop(
			"The database check after migrating did not pass, so this store was not deployed.",
			`${check.code === 2 ? "Some migrations are still pending." : check.code === 3 ? "The database has migrations this build does not know." : "The check could not read the database (see the message above)."} ${RETRY}`,
			NOT_DEPLOYED,
		);
	}
	if (check.report?.lock) log("Note: a migration lock is still held. It does not affect this deploy.");
	log("Database is up to date.");
}

function deploy() {
	return new Promise((done) => {
		// Same command as before this script existed, attached to the terminal.
		const child = spawn("wrangler", ["deploy"], {
			cwd: root,
			env: process.env,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", (error) => {
			console.error(`Could not start wrangler: ${error.message}`);
			done(1);
		});
		child.on("close", (code) => done(code ?? 1));
	});
}

async function main() {
	const args = process.argv.slice(2);
	const unknown = args.filter((arg) => arg !== "--migrate-only");
	if (unknown.length > 0) {
		stop(`Unknown argument: ${unknown.join(" ")}. This script only accepts --migrate-only. To pass options to Wrangler, run it directly.`);
	}

	if (!existsSync(MANIFEST)) {
		stop("The build output is missing (.emdash/migrations.json). Run `npm run build` first; `npm run deploy` needs what it produces.", NOT_DEPLOYED);
	}
	let binding = "DB";
	try {
		binding = JSON.parse(readFileSync(MANIFEST, "utf8"))?.database?.executorConfig?.binding ?? "DB";
	} catch {
		stop(".emdash/migrations.json could not be read. Run `npm run build` again.", NOT_DEPLOYED);
	}
	const config = readConfig(binding);

	if (!process.env.CLOUDFLARE_API_TOKEN) {
		stop(
			"CLOUDFLARE_API_TOKEN is not set, so this script cannot reach the store's database.",
			process.env.WORKERS_CI
				? "Your Worker > Settings > Build shows which API token the build uses; it needs D1 Edit, and the default token created by the Deploy button has it."
				: "Set it to an API token with D1 Edit permission: CLOUDFLARE_API_TOKEN=... npm run deploy",
			"Do not deploy a new store with plain `wrangler deploy`: the Worker would try to set up the database itself and be cut off.",
			NOT_DEPLOYED,
		);
	}

	const accountId = await resolveAccountId(config);
	await migrate(accountId);

	if (args.includes("--migrate-only")) {
		log("--migrate-only: not deploying.");
		return 0;
	}
	log("Deploying...");
	return deploy();
}

main().then(
	(code) => process.exit(code),
	(error) => {
		if (error instanceof Stop) {
			console.error(`\nDeploy stopped.\n${error.message}\n`);
		} else {
			console.error(scrub(`\nDeploy stopped: unexpected error: ${error?.stack ?? error}\n`));
		}
		process.exit(1);
	},
);
