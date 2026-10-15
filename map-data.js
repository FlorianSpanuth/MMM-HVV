/* MMM-HVV – data for the map view (server side)
 *
 * Everything is derived automatically from the config (home address + stations):
 *  - coordinates of home and stations (GTI checkName)
 *  - map area around them
 *  - street geometry from OpenStreetMap (Overpass API) – fetched once, cached on disk
 *  - line geometry (GTI departureCourse with showPath) and actual stop positions
 *    (GTI departureList stop points, reflects temporary relocations) – refreshed daily
 *  - live vehicles (GTI getVehicleMap) – every update interval
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { normalize } = require("./lib");

const CACHE_DIR = process.env.MMM_HVV_CACHE || path.join(os.homedir(), ".cache", "mmm-hvv");
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const USER_AGENT = "MMM-HVV (MagicMirror module; map prepared once and cached locally)";

// street classes: 3 = main roads … -1 = footways
const ROAD_CLASS = {
	motorway: 3, trunk: 3, primary: 3, secondary: 3,
	motorway_link: 2, trunk_link: 2, primary_link: 2, secondary_link: 2, tertiary: 2, tertiary_link: 2,
	unclassified: 1, residential: 1, living_street: 1, pedestrian: 1,
	service: 0,
	footway: -1, cycleway: -1, path: -1, steps: -1
};

const round = (v) => Math.round(v * 1e6) / 1e6;

async function readCache(name) {
	try {
		return JSON.parse(await fsp.readFile(path.join(CACHE_DIR, name), "utf8"));
	} catch {
		return null;
	}
}

async function writeCache(name, data) {
	await fsp.mkdir(CACHE_DIR, { recursive: true });
	await fsp.writeFile(path.join(CACHE_DIR, name), JSON.stringify(data));
}

// home: "Platz der Deutschen Einheit 1" (address, looked up once and cached) or { lat, lng }
async function locateHome(client, home) {
	if (home && typeof home === "object") return { name: home.name || "", lat: home.lat, lng: home.lng };
	const key = `home-${normalize(home).replace(/[^a-z0-9]+/g, "-")}.json`;
	const cached = await readCache(key);
	if (cached) return cached;
	const res = await client.call("checkName", { theName: { name: String(home), type: "ADDRESS" }, maxList: 1, coordinateType: "EPSG_4326" });
	const hit = res.results?.[0];
	if (!hit?.coordinate) throw new Error(`address "${home}" not found`);
	const result = { name: hit.name, lat: hit.coordinate.y, lng: hit.coordinate.x };
	await writeCache(key, result);
	return result;
}

async function locateStation(client, station) {
	const res = await client.call("checkName", { theName: { id: station.id, type: "STATION" }, maxList: 1, coordinateType: "EPSG_4326" });
	const hit = res.results?.[0];
	if (!hit?.coordinate) throw new Error(`station ${station.id} not found`);
	return { id: station.id, name: station.name || hit.name, lat: hit.coordinate.y, lng: hit.coordinate.x, types: hit.serviceTypes || [] };
}

// area that contains home and all stations, plus padding (at least ~150 m)
function areaAround(points, padding) {
	const lats = points.map((p) => p.lat);
	const lngs = points.map((p) => p.lng);
	const pLat = Math.max((Math.max(...lats) - Math.min(...lats)) * padding, 0.00135);
	const pLng = Math.max((Math.max(...lngs) - Math.min(...lngs)) * padding, 0.00225);
	return { south: Math.min(...lats) - pLat, west: Math.min(...lngs) - pLng, north: Math.max(...lats) + pLat, east: Math.max(...lngs) + pLng };
}

// outer area for streets/lines/vehicles (half the size again on each side), so wider or taller
// screens than the area's own aspect ratio are still covered
function outerArea(area) {
	const dLat = (area.north - area.south) / 2;
	const dLng = (area.east - area.west) / 2;
	return { south: area.south - dLat, west: area.west - dLng, north: area.north + dLat, east: area.east + dLng };
}

const inside = (a, lat, lng) => lat >= a.south && lat <= a.north && lng >= a.west && lng <= a.east;

// Street geometry from OpenStreetMap, fetched once per area and cached forever
async function streets(area, log) {
	const key = `streets-${[area.south, area.west, area.north, area.east].map((v) => v.toFixed(4)).join("_")}.json`;
	const cached = await readCache(key);
	if (cached) return cached;
	const bbox = `${area.south},${area.west},${area.north},${area.east}`;
	const query = `[out:json][timeout:120];way["highway"~"^(${Object.keys(ROAD_CLASS).join("|")})$"](${bbox});out geom;`;
	let lastError;
	for (const url of OVERPASS) {
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ data: query }),
				signal: AbortSignal.timeout(150000)
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const roads = data.elements
				.filter((w) => w.tags?.highway in ROAD_CLASS && w.geometry?.length > 1)
				.map((w) => ({ c: ROAD_CLASS[w.tags.highway], p: w.geometry.map((g) => [round(g.lat), round(g.lon)]) }));
			await writeCache(key, roads);
			log(`map: ${roads.length} streets from OpenStreetMap cached`);
			return roads;
		} catch (error) {
			lastError = error;
			log(`map: Overpass ${new URL(url).host} failed (${error.message}), trying next`);
		}
	}
	throw new Error(`street data unavailable: ${lastError?.message}`);
}

function gtiDateTime(d) {
	const p = (n) => String(n).padStart(2, "0");
	const offset = -d.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00.000${sign}${p(Math.floor(Math.abs(offset) / 60))}${p(Math.abs(offset) % 60)}`;
}

// clip a polyline to an area; returns the parts inside (with one point overlap at the edges)
function clip(points, area) {
	const parts = [];
	let current = [];
	points.forEach((p, i) => {
		const isIn = inside(area, p[0], p[1]);
		const prevIn = i > 0 && inside(area, points[i - 1][0], points[i - 1][1]);
		if (isIn) {
			if (!current.length && i > 0) current.push(points[i - 1]);
			current.push(p);
		} else if (prevIn) {
			current.push(p);
			parts.push(current);
			current = [];
		}
	});
	if (current.length > 1) parts.push(current);
	return parts;
}

// distance in meters from point p to segment a–b (all [lat, lng]); flat projection is fine at this scale
function distToSegment(p, a, b) {
	const kx = 111320 * Math.cos((p[0] * Math.PI) / 180);
	const ky = 110540;
	const [px, py] = [p[1] * kx, p[0] * ky];
	const [ax, ay] = [a[1] * kx, a[0] * ky];
	const [bx, by] = [b[1] * kx, b[0] * ky];
	const dx = bx - ax, dy = by - ay;
	const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Bus lines: both directions are drawn, but where they use the same street they merge into one.
// The first direction stays complete; of the others only the pieces more than `tolerance` meters
// away from it remain (e.g. one-way streets, detours in one direction only).
function mergeDirections(lines, tolerance = 15) {
	const kept = new Map(); // line name -> segments already drawn
	return lines.map((line) => {
		if (line.type !== "BUS") return line;
		const segments = kept.get(line.line) || [];
		const near = (p) => segments.some(([a, b]) => distToSegment(p, a, b) < tolerance);
		const parts = segments.length ? line.parts.flatMap((part) => {
			const runs = [];
			let run = [];
			part.forEach((p, i) => {
				if (!near(p)) {
					if (!run.length && i > 0) run.push(part[i - 1]); // connect to the shared street
					run.push(p);
				} else if (run.length) {
					run.push(p);
					runs.push(run);
					run = [];
				}
			});
			if (run.length > 1) runs.push(run);
			return runs.filter((r) => r.length > 1);
		}) : line.parts;
		for (const part of line.parts) for (let i = 1; i < part.length; i++) segments.push([part[i - 1], part[i]]);
		kept.set(line.line, segments);
		return { ...line, parts };
	}).filter((l) => l.parts.length);
}

// Line geometry for the configured lines and the stop points where they really depart
async function linesAndStops(client, stations, area) {
	const lines = new Map(); // "U3|6" -> { line, type, info, parts }
	const stops = new Map(); // globalId -> stop
	const directions = {}; // line -> { normalized destination -> directionId }
	const failed = new Set();
	// on the map, every configured line counts at every configured station
	// (e.g. a bus line also stops at a U-Bahn station where only U-Bahn departures are listed)
	const wanted = new Set(stations.flatMap((st) => (st.lines || []).map((r) => r.line)));
	for (const station of stations) {
		const res = await client.call("departureList", {
			station: { id: station.id, type: "STATION" },
			time: { date: "heute", time: "jetzt" },
			maxList: 300,
			maxTimeOffset: 480, // reaches the morning even when asked at night
			useRealtime: true
		});
		const [dd, mm, yy] = res.time.date.split(".").map(Number);
		const [h, mi] = res.time.time.split(":").map(Number);
		for (const dep of res.departures || []) {
			const name = dep.line.name;
			if (wanted.size && !wanted.has(name)) continue;
			const type = dep.line.type?.simpleType || "";
			const sp = dep.stopPoint;
			(directions[name] ??= {})[normalize(dep.line.direction)] = dep.directionId;
			if (type === "BUS" && sp?.coordinate) {
				const id = sp.globalId || sp.name;
				if (!stops.has(id)) stops.set(id, { id, name: sp.name, station: station.name, lat: sp.coordinate.y, lng: sp.coordinate.x, lines: new Set(), towards: new Set(), dirs: new Set(), moved: false });
				stops.get(id).lines.add(name);
				stops.get(id).towards.add(dep.line.direction);
				stops.get(id).dirs.add(dep.directionId);
			}
			const key = `${name}|${dep.directionId}`;
			if (lines.has(key) || failed.has(`${key}|${station.id}`)) continue;
			try {
				const course = await client.call("departureCourse", {
					lineKey: dep.line.id,
					// interchange stations: the course needs the sub-station the trip departs from (e.g. the bus stop of a U-Bahn station)
					station: { id: dep.station?.id || station.id, type: "STATION" },
					time: gtiDateTime(new Date(yy, mm - 1, dd, h, mi + dep.timeOffset)),
					serviceId: dep.serviceId,
					segments: "ALL",
					showPath: true,
					coordinateType: "EPSG_4326"
				});
				const track = (course.courseElements || []).flatMap((e) => (e.path?.track || []).map((p) => [round(p.y), round(p.x)]));
				lines.set(key, { line: name, type, info: dep.line.type?.longInfo || "", parts: clip(track, area) });
			} catch {
				// try this line again from the next station; geometry is optional anyway
				failed.add(`${key}|${station.id}`);
			}
		}
	}
	return {
		lines: mergeDirections([...lines.values()].filter((l) => l?.parts.length)),
		stops: [...stops.values()].map((s) => ({ ...s, lines: [...s.lines], towards: [...s.towards], dirs: [...s.dirs] })),
		directions
	};
}

// Live vehicles of the configured lines inside the area
async function vehicles(client, area, lineNames, horizonSec) {
	const now = Math.floor(Date.now() / 1000);
	const res = await client.call("getVehicleMap", {
		boundingBox: {
			lowerLeft: { x: area.west, y: area.south, type: "EPSG_4326" },
			upperRight: { x: area.east, y: area.north, type: "EPSG_4326" }
		},
		periodBegin: now - 60,
		periodEnd: now + horizonSec,
		withoutCoords: false,
		coordinateType: "EPSG_4326",
		vehicleTypes: ["U_BAHN", "S_BAHN", "A_BAHN", "R_BAHN", "METROBUS", "REGIONALBUS", "SCHNELLBUS", "XPRESSBUS", "NACHTBUS", "SCHIFF"],
		realtime: true
	});
	return (res.journeys || [])
		.filter((j) => !lineNames.size || lineNames.has(j.line?.name))
		.map((j) => ({
			id: j.journeyID,
			line: j.line.name,
			type: j.line.type?.simpleType || "",
			info: j.line.type?.longInfo || "",
			realtime: Boolean(j.realtime),
			segments: j.segments.map((s) => {
				const flat = s.track?.track || [];
				const track = [];
				for (let i = 0; i + 1 < flat.length; i += 2) track.push([round(flat[i + 1]), round(flat[i])]);
				return { t0: Number(s.startDateTime) * 1000, t1: Number(s.endDateTime) * 1000, track };
			})
		}));
}

// Mark stops as temporarily relocated if a current announcement says so.
// "in Richtung X" is matched to the direction (directionId) whose trips go to X; without a
// direction (e.g. "stadtauswärts") all stops of that station and line are marked.
function markRelocations(stops, announcements, directions = {}) {
	const now = Date.now();
	const relocation = /verlegt|ersatzhaltestelle|ersatzweise/;
	for (const stop of stops) stop.moved = false;
	for (const a of announcements) {
		const periods = a.validities?.length ? a.validities : a.publication ? [a.publication] : [];
		if (periods.length && !periods.some((p) => Date.parse(p.begin) <= now && (!p.end || now <= Date.parse(p.end)))) continue;
		const text = normalize(`${a.summary} ${a.description}`);
		if (!relocation.test(text)) continue;
		const lines = new Set((a.locations || []).map((l) => l.line?.name).filter(Boolean));
		const towards = [...text.matchAll(/richtung ([a-z0-9.\- ]+?)(?: \(|,|\.| eine| fahrt| um| an | in | der | die | das |$)/g)].map((m) => m[1].trim());
		for (const stop of stops) {
			const line = stop.lines.find((l) => lines.has(l));
			if (!line) continue;
			if (!text.includes(normalize(stop.station)) && !text.includes(normalize(stop.name.replace(/\s+\S$/, "")))) continue;
			if (towards.length && stop.dirs) {
				const dirIds = new Set(
					Object.entries(directions[line] || {})
						.filter(([dest]) => towards.some((t) => dest.includes(t) || t.includes(dest)))
						.map(([, id]) => id)
				);
				if (dirIds.size && !stop.dirs.some((d) => dirIds.has(d))) continue;
			}
			stop.moved = true;
		}
	}
	return stops;
}

// last successful map setup (without streets – those have their own cache), keyed by home + stations
function mapCacheName(config) {
	const key = JSON.stringify([config.home, config.stations.map((s) => [s.id, (s.lines || []).map((r) => r.line)]), config.mapPadding]);
	let h = 0;
	for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
	return `map-${(h >>> 0).toString(16)}.json`;
}
const readMapCache = (config) => readCache(mapCacheName(config));
const writeMapCache = (config, map) => writeCache(mapCacheName(config), map);

module.exports = { readMapCache, writeMapCache, mergeDirections, locateHome, locateStation, areaAround, outerArea, streets, linesAndStops, vehicles, markRelocations, CACHE_DIR };
