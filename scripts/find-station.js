#!/usr/bin/env node
/* Find station IDs and the lines/directions that serve them.
 *
 *   HVV_API_USER=... HVV_API_KEY=... node scripts/find-station.js "Baumwall"
 *
 * Prints matching stations and, for the best match, a ready-to-paste config snippet.
 * Uses two API requests.
 */
const { GtiClient } = require("../gti");

async function main() {
	const name = process.argv.slice(2).join(" ");
	const { HVV_API_USER: user, HVV_API_KEY: key } = process.env;
	if (!name || !user || !key) {
		console.error('Usage: HVV_API_USER=<user> HVV_API_KEY=<key> node scripts/find-station.js "<station name>"');
		process.exit(1);
	}
	const client = new GtiClient({ user, key });

	const found = await client.call("checkName", { theName: { name, type: "STATION" }, maxList: 5 });
	const results = found.results || [];
	if (!results.length) {
		console.log(`No station found for "${name}".`);
		return;
	}
	console.log("Matches:");
	for (const r of results) console.log(`  ${r.id.padEnd(16)} ${r.name}, ${r.city}  [${(r.serviceTypes || []).join(", ")}]`);

	const best = results[0];
	const deps = await client.call("departureList", {
		station: { id: best.id, type: "STATION" },
		time: { date: "heute", time: "jetzt" },
		maxList: 1,
		maxTimeOffset: 1,
		useRealtime: false,
		returnFilters: true
	});
	const byLine = new Map();
	for (const f of deps.filter || []) {
		if (!byLine.has(f.serviceName)) byLine.set(f.serviceName, []);
		byLine.get(f.serviceName).push(...String(f.label || "").split(" / "));
	}
	console.log(`\nLines and directions at ${best.name}:`);
	const sorted = [...byLine.entries()].sort(([a], [b]) => a.localeCompare(b, "de", { numeric: true }));
	for (const [line, dirs] of sorted) console.log(`  ${line.padEnd(5)} → ${[...new Set(dirs)].join(" | ")}`);

	console.log("\nConfig snippet (keep only the lines you need, add a direction to narrow it down):");
	console.log(`  { id: "${best.id}", name: "${best.name}", walkTime: "5:00", lines: [${sorted.map(([l]) => `"${l}"`).join(", ")}] },`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
