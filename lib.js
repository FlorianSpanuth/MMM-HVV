/* MMM-HVV – pure helper functions (no I/O), shared by node_helper.js and the tests */

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];


// Drop connections that a later one beats: departing later but arriving no later.
// E.g. a U3 that misses the U1 connection arrives together with the next U3 – only the later one is useful.
function paretoFront(schedules) {
	const sorted = [...schedules].sort((a, b) => b.leaveBase - a.leaveBase || a.arrival - b.arrival);
	const keep = [];
	let bestArrival = Infinity;
	for (const s of sorted) {
		if (s.arrival < bestArrival) {
			keep.push(s);
			bestArrival = s.arrival;
		}
	}
	return keep.reverse();
}

// The legs you actually ride, plus walks between two different stops in the middle of a trip.
// Changes within a station and walks at the very start/end are left out.
function tripChain(elements) {
	const chain = [];
	elements.forEach((e, i) => {
		const type = e.line?.type?.simpleType;
		if (type === "CHANGE") return;
		if (type === "FOOTPATH") {
			if (i > 0 && i < elements.length - 1) chain.push({ walk: true });
			return;
		}
		chain.push({ line: e.line.name, type: type || "", info: e.line.type?.longInfo || e.line.type?.shortInfo || "" });
	});
	return chain;
}

// when: undefined (always) | { days: "mon-fri", from: "07:00", to: "09:30" } | [ ...windows ]
function routeActive(when, date) {
	if (!when) return true;
	const windows = [].concat(when);
	const day = DAYS[date.getDay()];
	const minutes = date.getHours() * 60 + date.getMinutes();
	return windows.some((w) => {
		if (w.days && !expandDays(w.days).includes(day)) return false;
		const from = w.from ? toMinutes(w.from) : 0;
		const to = w.to ? toMinutes(w.to) : 24 * 60;
		return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
	});
}

// "mon-fri" | "sat,sun" | ["mon", "wed"] | "daily" | "weekend"
function expandDays(days) {
	const parts = [].concat(days).flatMap((d) => String(d).toLowerCase().split(","));
	const out = new Set();
	for (const part of parts.map((p) => p.trim())) {
		if (part === "daily" || part === "all") DAYS.forEach((d) => out.add(d));
		else if (part === "weekdays") ["mon", "tue", "wed", "thu", "fri"].forEach((d) => out.add(d));
		else if (part === "weekend") ["sat", "sun"].forEach((d) => out.add(d));
		else if (part.includes("-")) {
			const [a, b] = part.split("-").map((d) => DAYS.indexOf(d.slice(0, 3)));
			for (let i = a; ; i = (i + 1) % 7) {
				out.add(DAYS[i]);
				if (i === b) break;
			}
		} else out.add(part.slice(0, 3));
	}
	return [...out];
}

function toMinutes(hhmm) {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}

function gtiDate(d) {
	return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

function gtiTime(d) {
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// GTI time ("15.10.2026", "00:13") in local time (the mirror runs in Hamburg's time zone)
function parseGtiTime({ date, time }) {
	const [d, m, y] = date.split(".").map(Number);
	const [hh, mm] = time.split(":").map(Number);
	return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

// the line rule a departure matches: undefined = no rules (show all), null = filtered out
function matchingRule(dep, rules) {
	if (!rules?.length) return undefined;
	const direction = normalize(dep.line.direction);
	return (
		rules.find((rule) => rule.line === dep.line.name && (!rule.direction?.length || rule.direction.some((d) => direction.includes(normalize(d))))) ?? null
	);
}

function normalize(s) {
	return String(s || "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/ß/g, "ss");
}

function inQuietHours({ from, to }) {
	const now = new Date();
	const minutes = now.getHours() * 60 + now.getMinutes();
	const [fh, fm] = from.split(":").map(Number);
	const [th, tm] = to.split(":").map(Number);
	const start = fh * 60 + fm;
	const end = th * 60 + tm;
	return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// keep announcements that are valid right now and concern the configured stations (or lines)
function relevantAnnouncements(announcements, config) {
	const now = Date.now();
	const stationNames = config.stations.map((s) => normalize(s.name));
	const lineNames = new Set(config.stations.flatMap((s) => (s.lines || []).map((r) => r.line)));
	const out = [];
	for (const a of announcements) {
		const periods = a.validities?.length ? a.validities : a.publication ? [a.publication] : [];
		const valid = !periods.length || periods.some((p) => Date.parse(p.begin) <= now && (!p.end || now <= Date.parse(p.end)));
		if (!valid) continue;

		const lines = [...new Set((a.locations || []).map((l) => l.line?.name).filter(Boolean))];
		const places = (a.locations || []).flatMap((l) => [l.begin?.name, l.end?.name]).filter(Boolean);
		const text = normalize(`${a.summary} ${a.description} ${places.join(" ")}`);
		const atStation = stationNames.some((n) => text.includes(n));
		const onLine = !lineNames.size || lines.some((l) => lineNames.has(l));
		if (config.announcementScope === "stations" ? !atStation : !onLine) continue;

		out.push({
			id: a.id,
			summary: a.summary,
			description: a.description,
			lines,
			planned: Boolean(a.planned),
			atStation,
			end: periods.map((p) => p.end).filter(Boolean).sort().pop() || null
		});
	}
	// station-related and unplanned (disruptions) first
	return out.sort((x, y) => y.atStation - x.atStation || x.planned - y.planned).slice(0, config.maxAnnouncements);
}

module.exports = { DAYS, tripChain, parseGtiTime, gtiDate, gtiTime, matchingRule, normalize, inQuietHours, routeActive, expandDays, paretoFront, relevantAnnouncements };
