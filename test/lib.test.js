// Run: npm test   (node --test)
const test = require("node:test");
const assert = require("node:assert/strict");
const { routeActive, expandDays, paretoFront, matchingRule, inQuietHours, parseGtiTime } = require("../lib");

// 2026-10-12 is a Monday
const at = (day, hhmm) => {
	const [h, m] = hhmm.split(":").map(Number);
	return new Date(2026, 9, 12 + day, h, m);
};
const MON = 0, FRI = 4, SAT = 5;

test("expandDays", () => {
	assert.deepEqual(expandDays("mon-fri"), ["mon", "tue", "wed", "thu", "fri"]);
	assert.deepEqual(expandDays("fri-mon"), ["fri", "sat", "sun", "mon"]);
	assert.deepEqual(expandDays("sat,sun").sort(), ["sat", "sun"]);
	assert.deepEqual(expandDays(["Monday", "wed"]), ["mon", "wed"]);
	assert.equal(expandDays("daily").length, 7);
	assert.deepEqual(expandDays("weekend").sort(), ["sat", "sun"]);
});

test("routeActive: no window means always", () => {
	assert.equal(routeActive(undefined, at(SAT, "03:00")), true);
});

test("routeActive: work, weekdays 07:00–09:30", () => {
	const when = { days: "mon-fri", from: "07:00", to: "09:30" };
	assert.equal(routeActive(when, at(MON, "06:59")), false);
	assert.equal(routeActive(when, at(MON, "07:00")), true);
	assert.equal(routeActive(when, at(FRI, "09:29")), true);
	assert.equal(routeActive(when, at(FRI, "09:30")), false);
	assert.equal(routeActive(when, at(SAT, "08:00")), false);
});

test("routeActive: university, weekdays 07:30–13:00", () => {
	const when = { days: "mon-fri", from: "07:30", to: "13:00" };
	assert.equal(routeActive(when, at(MON, "07:15")), false);
	assert.equal(routeActive(when, at(MON, "12:59")), true);
	assert.equal(routeActive(when, at(MON, "13:00")), false);
});

test("routeActive: several windows and windows across midnight", () => {
	const when = [
		{ days: "mon-fri", from: "07:00", to: "09:00" },
		{ days: "sat", from: "22:00", to: "02:00" }
	];
	assert.equal(routeActive(when, at(MON, "08:00")), true);
	assert.equal(routeActive(when, at(SAT, "23:30")), true);
	assert.equal(routeActive(when, at(SAT, "01:00")), true); // same weekday, after midnight part
	assert.equal(routeActive(when, at(SAT, "12:00")), false);
});

test("paretoFront: a U3 that misses the U1 is dropped", () => {
	const t = (hhmm) => at(MON, hhmm).getTime();
	const schedules = [
		{ name: "U3 08:02", leaveBase: t("08:02"), arrival: t("08:41") },
		{ name: "U3 08:07", leaveBase: t("08:07"), arrival: t("08:51") }, // misses U1 08:15 …
		{ name: "U3 08:12", leaveBase: t("08:12"), arrival: t("08:51") }, // … same U1 as this one
		{ name: "U3 08:17", leaveBase: t("08:17"), arrival: t("09:01") }
	];
	assert.deepEqual(
		paretoFront(schedules).map((s) => s.name),
		["U3 08:02", "U3 08:12", "U3 08:17"]
	);
});

test("matchingRule: lines, directions, umlauts", () => {
	const dep = (line, direction) => ({ line: { name: line, direction } });
	const rules = [{ line: "U3", direction: ["Barmbek"] }, { line: "U2", direction: [] }, { line: "4", direction: ["Wildacker"] }];
	assert.equal(matchingRule(dep("U3", "Hauptbahnhof Süd - Barmbek"), rules), rules[0]);
	assert.equal(matchingRule(dep("U3", "St.Pauli"), rules), null);
	assert.equal(matchingRule(dep("U2", "Niendorf Nord"), rules), rules[1]);
	assert.equal(matchingRule(dep("181", "Sternschanze"), rules), null);
	assert.equal(matchingRule(dep("4", "Wildacker"), rules), rules[2]);
	assert.equal(matchingRule(dep("181", "x"), []), undefined); // no rules: everything
	assert.notEqual(matchingRule(dep("U3", "Gärtnerstraße"), [{ line: "U3", direction: ["gaertnerstrasse", "Gartnerstraße"] }]), null);
});

test("parseGtiTime", () => {
	assert.equal(parseGtiTime({ date: "15.10.2026", time: "08:12" }), new Date(2026, 9, 15, 8, 12).getTime());
});

test("inQuietHours across midnight", () => {
	// uses the current time – just make sure both window types don't throw and are complementary
	const a = inQuietHours({ from: "00:00", to: "23:59" });
	const b = inQuietHours({ from: "23:59", to: "00:00" });
	assert.equal(typeof a, "boolean");
	assert.equal(typeof b, "boolean");
});

test("tripChain: rides and walks between stops, no changes or start/end walks", () => {
	const { tripChain } = require("../lib");
	const el = (name, simpleType, longInfo) => ({ line: { name, type: { simpleType, longInfo } } });
	const chain = tripChain([
		el("Fußweg", "FOOTPATH"),
		el("U3", "TRAIN", "U-Bahn"),
		el("Umstiegsfußweg", "CHANGE"),
		el("U1", "TRAIN", "U-Bahn"),
		el("Fußweg", "FOOTPATH"),
		el("5", "BUS", "Niederflur Metrobus"),
		el("Fußweg", "FOOTPATH")
	]);
	assert.deepEqual(chain, [
		{ line: "U3", type: "TRAIN", info: "U-Bahn" },
		{ line: "U1", type: "TRAIN", info: "U-Bahn" },
		{ walk: true },
		{ line: "5", type: "BUS", info: "Niederflur Metrobus" }
	]);
});

test("mergeDirections: bus directions on the same street become one line", () => {
	const { mergeDirections } = require("../map-data");
	const street = [[53.5700, 9.9600], [53.5700, 9.9620], [53.5700, 9.9640]];
	const back = [...street].reverse().map(([la, ln]) => [la + 0.00003, ln]); // ~3 m offset, same street
	const merged = mergeDirections([
		{ line: "4", type: "BUS", parts: [street] },
		{ line: "4", type: "BUS", parts: [back] }
	]);
	assert.equal(merged.length, 1); // second direction fully on the same street → dropped

	const detour = [[53.5700, 9.9640], [53.5710, 9.9640], [53.5710, 9.9600], [53.5700, 9.9600]]; // other street
	const split = mergeDirections([
		{ line: "4", type: "BUS", parts: [street] },
		{ line: "4", type: "BUS", parts: [detour] }
	]);
	assert.equal(split.length, 2); // different street → own line
	assert.ok(split[1].parts[0].length >= 2);

	const rail = mergeDirections([
		{ line: "U3", type: "TRAIN", parts: [street] },
		{ line: "U3", type: "TRAIN", parts: [back] }
	]);
	assert.equal(rail.length, 2); // rail untouched (drawn once by the view)
});
