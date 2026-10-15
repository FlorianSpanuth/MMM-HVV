/* MMM-HVV – server side
 *
 * Keeps API traffic low:
 *  - one combined departureList request for all configured stations per update
 *  - line filtering happens on the server (filter by serviceID), direction filtering locally
 *  - announcements are fetched rarely (default every 10 minutes)
 *  - slower polling during quiet hours, no polling while the module is hidden,
 *    exponential backoff on errors
 *
 * Interchange stations (e.g. "Hauptbahnhof": U-Bahn, S-Bahn and bus stops) return departures with the IDs of
 * their sub-stations. On start, each station is queried once on its own to learn which
 * sub-station IDs belong to it and which lines (service IDs) serve it.
 *
 * view "routes": one getRoute request per route, only inside the route's time windows,
 * every 2 minutes when a departure is coming up soon, every 5 minutes otherwise.
 *
 * view "map": setup once a day (coordinates, line geometry, stop positions; streets are cached
 * on disk for good), live vehicles every updateInterval, relocation info every 30 minutes.
 */
const NodeHelper = require("node_helper");
const Log = require("logger");
const { GtiClient } = require("./gti");
const mapData = require("./map-data");
const { parseGtiTime, gtiDate, gtiTime, matchingRule, inQuietHours, routeActive, paretoFront, relevantAnnouncements, tripChain } = require("./lib");

const LEARN_EVERY_MS = 24 * 3600 * 1000;
const ROUTE_CHECK_MS = 60 * 1000; // local check (no API) whether a route needs a refresh
const MAX_BACKOFF_MS = 15 * 60 * 1000;

module.exports = NodeHelper.create({
	start() {
		this.instances = new Map();
	},

	socketNotificationReceived(notification, payload) {
		const { identifier } = payload || {};
		if (notification === "HVV_START") {
			let inst = this.instances.get(identifier);
			if (inst) {
				// another browser/window showing the same module: just resend what we have
				this.resend(inst);
				return;
			}
			inst = { identifier, config: payload.config, suspended: false, backoff: 0, learnedAt: 0, data: null, announcements: [], places: new Map(), routeState: new Map() };
			try {
				inst.client = new GtiClient({ user: inst.config.apiUser, key: inst.config.apiKey, baseUrl: inst.config.apiBase });
			} catch (error) {
				this.sendError(inst, error);
				return;
			}
			this.instances.set(identifier, inst);
			if (inst.config.view === "routes") {
				this.updateRoutes(inst);
				return;
			}
			if (inst.config.view === "map") {
				this.updateMap(inst);
				return;
			}
			this.update(inst);
			if (inst.config.showAnnouncements || inst.config.showRelocations) this.updateAnnouncements(inst);
		} else if (notification === "HVV_SUSPEND") {
			const inst = this.instances.get(identifier);
			if (!inst) return;
			inst.suspended = true;
			clearTimeout(inst.timer);
			clearTimeout(inst.annTimer);
		} else if (notification === "HVV_RESUME") {
			const inst = this.instances.get(identifier);
			if (!inst || !inst.suspended) return;
			inst.suspended = false;
			if (inst.config.view === "routes") {
				this.updateRoutes(inst);
				return;
			}
			if (inst.config.view === "map") {
				this.updateMap(inst);
				return;
			}
			const age = Date.now() - (inst.data?.fetchedAt || 0);
			if (age > this.interval(inst)) this.update(inst);
			else this.schedule(inst, this.interval(inst) - age);
			if (inst.config.showAnnouncements || inst.config.showRelocations) this.updateAnnouncements(inst);
		}
	},

	resend(inst) {
		if (inst.config.view === "map") {
			if (inst.map) this.sendSocketNotification("HVV_MAP", { identifier: inst.identifier, ...inst.map });
			if (inst.vehicles) this.sendSocketNotification("HVV_VEHICLES", { identifier: inst.identifier, vehicles: inst.vehicles });
			return;
		}
		if (inst.config.view === "routes") {
			if (inst.data) this.sendSocketNotification("HVV_ROUTES", { identifier: inst.identifier, ...inst.data });
			return;
		}
		if (inst.data) this.sendSocketNotification("HVV_DATA", { identifier: inst.identifier, ...inst.data });
		this.sendSocketNotification("HVV_ANNOUNCEMENTS", { identifier: inst.identifier, announcements: inst.announcements });
	},

	sendError(inst, error) {
		Log.error(`${error.message}`);
		this.sendSocketNotification("HVV_ERROR", { identifier: inst.identifier, message: error.message });
	},

	// --- scheduling ---------------------------------------------------------------

	interval(inst) {
		const { updateInterval, quietHours } = inst.config;
		if (quietHours && inQuietHours(quietHours)) return quietHours.interval * 1000;
		return updateInterval * 1000;
	},

	schedule(inst, ms) {
		clearTimeout(inst.timer);
		if (inst.suspended) return;
		inst.timer = setTimeout(() => this.update(inst), ms);
	},

	async update(inst) {
		try {
			if (Date.now() - inst.learnedAt > LEARN_EVERY_MS) await this.learn(inst);
			inst.data = await this.fetchDepartures(inst);
			inst.backoff = 0;
			this.sendSocketNotification("HVV_DATA", { identifier: inst.identifier, ...inst.data });
			this.schedule(inst, this.interval(inst));
		} catch (error) {
			this.sendError(inst, error);
			inst.backoff = Math.min(MAX_BACKOFF_MS, inst.backoff ? inst.backoff * 2 : 60 * 1000);
			this.schedule(inst, Math.max(inst.backoff, this.interval(inst)));
		}
	},

	// --- learning station structure (once per day) --------------------------------

	async learn(inst) {
		const stations = inst.config.stations;
		inst.subStations = new Map(); // station.id from departures -> index of configured station
		inst.serviceIds = new Map(); // line name -> Set of serviceIDs
		for (const [index, station] of stations.entries()) {
			inst.subStations.set(station.id, index);
			const res = await inst.client.call("departureList", {
				station: { id: station.id, type: "STATION" },
				time: { date: "heute", time: "jetzt" },
				maxList: 100,
				maxTimeOffset: 180,
				useRealtime: false,
				returnFilters: true
			});
			for (const dep of res.departures || []) {
				if (dep.station?.id) inst.subStations.set(dep.station.id, index);
			}
			const available = new Set();
			for (const f of res.filter || []) {
				available.add(f.serviceName);
				if (!inst.serviceIds.has(f.serviceName)) inst.serviceIds.set(f.serviceName, new Set());
				inst.serviceIds.get(f.serviceName).add(f.serviceID);
			}
			for (const rule of station.lines || []) {
				if (!available.has(rule.line)) {
					Log.warn(`${station.name}: line "${rule.line}" not found. Available: ${[...available].sort().join(", ")}`);
				}
			}
		}
		inst.learnedAt = Date.now();
		Log.log(`learned ${inst.subStations.size} stop IDs for ${stations.length} station(s)`);
	},

	// --- departures -------------------------------------------------------------------

	async fetchDepartures(inst) {
		const { stations, maxTimeOffset, departuresPerStation } = inst.config;

		// server-side line filter, only if every station restricts its lines
		let filter;
		if (stations.every((s) => s.lines?.length)) {
			const ids = new Set();
			for (const s of stations) for (const rule of s.lines) for (const id of inst.serviceIds.get(rule.line) || []) ids.add(id);
			if (ids.size) filter = [...ids].map((serviceID) => ({ serviceID }));
		}

		const res = await inst.client.call("departureList", {
			stations: stations.map((s) => ({ id: s.id, type: "STATION" })),
			time: { date: "heute", time: "jetzt" },
			maxList: 150,
			maxTimeOffset,
			useRealtime: true,
			...(filter ? { filter } : {})
		});

		const reference = parseGtiTime(res.time);
		const result = stations.map((s) => ({ name: s.name, walkTime: s.walkTime, departures: [] }));
		let unknown = 0;
		for (const dep of res.departures || []) {
			const index = inst.subStations.get(dep.station?.id);
			if (index === undefined) {
				unknown++;
				continue;
			}
			const station = stations[index];
			const rule = matchingRule(dep, station.lines);
			if (rule === null) continue;
			const planned = reference + dep.timeOffset * 60000;
			const hasRealtime = typeof dep.delay === "number";
			result[index].departures.push({
				line: dep.line.name,
				type: dep.line.type?.simpleType || "",
				info: dep.line.type?.longInfo || dep.line.type?.shortInfo || "",
				direction: dep.line.direction,
				directionId: dep.directionId ?? null, // 1 = forward, 6 = backward
				planned,
				realtime: planned + (hasRealtime ? dep.delay * 1000 : 0),
				delay: hasRealtime ? dep.delay : null,
				walk: rule?.walkTime ?? station.walkTime, // per-line walking time overrides the station's
				moved: Boolean(inst.relocated?.has(`${index}|${dep.line.name}`)),
				cancelled: Boolean(dep.cancelled),
				extra: Boolean(dep.extra),
				platform: dep.platform || null,
				realtimePlatform: dep.realtimePlatform && dep.realtimePlatform !== dep.platform ? dep.realtimePlatform : null
			});
		}
		// unknown stop IDs: the station structure changed – relearn on next update
		if (unknown) inst.learnedAt = 0;

		const now = Date.now();
		for (const r of result) {
			r.departures = r.departures
				.filter((d) => d.realtime > now - 60000)
				.sort((a, b) => a.realtime - b.realtime)
				// a few extra entries, so the client can drop unreachable ones and still fill its rows
				.slice(0, departuresPerStation + 6);
		}
		return { stations: result, fetchedAt: now, requests: inst.client.requestCount };
	},

	// --- routes -------------------------------------------------------------------------

	// called every minute: refreshes only routes that are active and stale (no API call otherwise)
	async updateRoutes(inst) {
		clearTimeout(inst.timer);
		if (inst.suspended) return;
		const now = Date.now();
		const { routes, routeInterval, routeIntervalFar, buffer } = inst.config;
		const result = [];
		let failed = null;
		for (const [index, route] of routes.entries()) {
			if (!routeActive(route.when, new Date(now))) continue;
			const state = inst.routeState.get(index) || { fetchedAt: 0, schedules: [] };
			// soon = someone might have to leave within the next 20 minutes
			const nextLeave = state.schedules.map((s) => s.leaveBase - s.walk - buffer * 1000).find((t) => t > now);
			const soon = nextLeave === undefined || nextLeave - now < 20 * 60000;
			const quiet = inst.config.quietHours && inQuietHours(inst.config.quietHours);
			const maxAge = (quiet ? inst.config.quietHours.interval : soon ? routeInterval : routeIntervalFar) * 1000;
			// refresh when stale, or early when every known connection is already out of reach
			const allMissed = state.schedules.length > 0 && !state.schedules.some((s) => s.leaveBase - s.walk >= now);
			if (now - state.fetchedAt >= maxAge || (allMissed && now - state.fetchedAt >= 60000)) {
				try {
					({ schedules: state.schedules, origin: state.origin } = await this.fetchRoute(inst, route));
					state.fetchedAt = now;
					inst.backoff = 0;
				} catch (error) {
					failed = error;
				}
				inst.routeState.set(index, state);
			}
			result.push({ name: route.name, origin: state.origin, schedules: state.schedules });
		}
		inst.data = { routes: result, fetchedAt: now, requests: inst.client.requestCount };
		this.sendSocketNotification("HVV_ROUTES", { identifier: inst.identifier, ...inst.data });
		if (failed) {
			this.sendError(inst, failed);
			inst.backoff = Math.min(MAX_BACKOFF_MS, inst.backoff ? inst.backoff * 2 : 2 * 60 * 1000);
		}
		inst.timer = setTimeout(() => this.updateRoutes(inst), Math.max(ROUTE_CHECK_MS, failed ? inst.backoff : 0));
	},

	// station ID ("Master:11907") or name ("Hamburg Airport") → SDName; names are looked up once
	async place(inst, ref) {
		if (/^[A-Za-z]+:\S+$/.test(ref)) return { id: ref, type: "STATION" };
		const cached = inst.places.get(ref);
		if (cached && Date.now() - cached.at < LEARN_EVERY_MS) return cached.sd;
		const res = await inst.client.call("checkName", { theName: { name: ref, type: "STATION" }, maxList: 1 });
		const hit = res.results?.[0];
		if (!hit) throw new Error(`station "${ref}" not found`);
		const sd = { id: hit.id, type: "STATION" };
		inst.places.set(ref, { sd, at: Date.now() });
		Log.log(`"${ref}" → ${hit.name}, ${hit.city} (${hit.id})`);
		return sd;
	},

	async fetchRoute(inst, route) {
		const start = await this.place(inst, route.from);
		const dest = await this.place(inst, route.to);
		// earliest departure that is still reachable on foot
		const minWalk = Math.min(route.walkTime.default, ...Object.values(route.walkTime.lines));
		const from = new Date(Date.now() + minWalk);
		const res = await inst.client.call("getRoute", {
			start,
			dest,
			time: { date: gtiDate(from), time: gtiTime(from) },
			timeIsDeparture: true,
			schedulesBefore: 0,
			schedulesAfter: route.options + 2,
			realtime: "REALTIME"
		});
		const schedules = (res.realtimeSchedules || res.schedules || []).map((s) => {
			const legs = s.scheduleElements.filter((e) => !["FOOTPATH", "CHANGE"].includes(e.line?.type?.simpleType));
			const first = legs[0] || s.scheduleElements[0];
			const plannedDep = parseGtiTime(first.from.depTime);
			return {
				line: first.line.name,
				type: first.line.type?.simpleType || "",
				info: first.line.type?.longInfo || first.line.type?.shortInfo || "",
				boardAt: first.from.name,
				departure: plannedDep + (first.from.depDelay || 0) * 1000,
				delay: typeof first.from.depDelay === "number" ? first.from.depDelay : null,
				arrival: Date.parse(s.realArrivalTime || s.plannedArrivalTime),
				arrivalDelay: Date.parse(s.realArrivalTime || s.plannedArrivalTime) - Date.parse(s.plannedArrivalTime),
				transfers: Math.max(0, legs.length - 1),
				chain: tripChain(s.scheduleElements),
				// leaving the origin station (includes footpaths at the start, e.g. to a bus stop)
				leaveBase: Date.parse(s.realDepartureTime || s.plannedDepartureTime),
				walk: route.walkTime.lines[first.line.name] ?? route.walkTime.default
			};
		});
		return { schedules: paretoFront(schedules).slice(0, route.options + 1), origin: res.realtimeSchedules?.[0]?.start?.name ?? res.schedules?.[0]?.start?.name ?? "" };
	},

	// --- map --------------------------------------------------------------------------------

	// coordinates, map area, line paths and stop positions (streets are loaded separately)
	async buildMap(inst, now) {
		const home = await mapData.locateHome(inst.client, inst.config.home);
		const stations = [];
		for (const s of inst.config.stations) stations.push({ ...(await mapData.locateStation(inst.client, s)), lines: s.lines });
		const area = mapData.areaAround([home, ...stations], inst.config.mapPadding);
		inst.mapArea = mapData.outerArea(area);
		const { lines, stops, directions } = await mapData.linesAndStops(inst.client, inst.config.stations, inst.mapArea);
		inst.mapDirections = directions;
		inst.map = { builtAt: now, home, stations: stations.map(({ lines: _, ...s }) => s), area, roads: inst.map?.roads || [], lines, stops };
		inst.relocationsAt = 0;
		Log.log(`map ready: ${lines.length} line paths, ${stops.length} bus stops`);
		await mapData.writeMapCache(inst.config, { ...inst.map, roads: undefined, directions: inst.mapDirections });
	},

	async updateMap(inst) {
		clearTimeout(inst.timer);
		if (inst.suspended) return;
		const now = Date.now();
		const log = (m) => Log.log(m);
		try {
			// setup: once a day (streets come from the disk cache after the first time)
			if (!inst.map || now - inst.map.builtAt > LEARN_EVERY_MS) {
				try {
					await this.buildMap(inst, now);
				} catch (error) {
					// API down right at start: use the last successful setup from disk, retry later
					const cached = inst.map ? null : await mapData.readMapCache(inst.config);
					if (!cached) throw error;
					inst.map = { ...cached, builtAt: now - LEARN_EVERY_MS + 15 * 60000, roads: [] };
					inst.mapArea = mapData.outerArea(cached.area);
					inst.mapDirections = cached.directions;
					inst.relocationsAt = 0;
					inst.mapFromCache = true;
					Log.warn(`map setup failed (${error.message}) – using the cached map, retrying in 15 min`);
				}
			}
			// streets: in the background, so the map shows up right away; retried every 30 min until it works
			if (!inst.map.roads.length && !inst.streetsPending && now - (inst.streetsTriedAt || 0) > 30 * 60000) {
				inst.streetsPending = true;
				inst.streetsTriedAt = now;
				mapData
					.streets(inst.mapArea, log)
					.then((roads) => {
						inst.map.roads = roads;
						this.sendSocketNotification("HVV_MAP", { identifier: inst.identifier, ...inst.map });
					})
					.catch((error) => Log.warn(`${error.message} – map without streets for now`))
					.finally(() => (inst.streetsPending = false));
			}
			// temporary stop relocations from announcements: every 30 minutes
			let changed = inst.map.builtAt === now || inst.mapFromCache;
			inst.mapFromCache = false;
			if (now - (inst.relocationsAt || 0) > 30 * 60000) {
				const names = [...new Set(inst.config.stations.flatMap((s) => (s.lines || []).map((r) => r.line)))];
				const res = await inst.client.call("getAnnouncements", { ...(names.length ? { names } : {}), full: true, filterPlanned: "NO_FILTER" });
				const before = inst.map.stops.map((x) => x.moved).join();
				mapData.markRelocations(inst.map.stops, res.announcements || [], inst.mapDirections);
				changed ||= before !== inst.map.stops.map((x) => x.moved).join();
				inst.relocationsAt = now;
			}
			// the map (≈ 300 KB incl. streets) only goes to the browser when it changed
			if (changed) this.sendSocketNotification("HVV_MAP", { identifier: inst.identifier, ...inst.map });

			const lineNames = new Set(inst.config.stations.flatMap((s) => (s.lines || []).map((r) => r.line)));
			inst.vehicles = await mapData.vehicles(inst.client, inst.mapArea, lineNames, inst.config.updateInterval + 90);
			this.sendSocketNotification("HVV_VEHICLES", { identifier: inst.identifier, vehicles: inst.vehicles, requests: inst.client.requestCount });
			inst.backoff = 0;
			inst.timer = setTimeout(() => this.updateMap(inst), this.interval(inst));
		} catch (error) {
			this.sendError(inst, error);
			inst.backoff = Math.min(MAX_BACKOFF_MS, inst.backoff ? inst.backoff * 2 : 60 * 1000);
			inst.timer = setTimeout(() => this.updateMap(inst), Math.max(inst.backoff, this.interval(inst)));
		}
	},

	// --- announcements ---------------------------------------------------------------

	async updateAnnouncements(inst) {
		clearTimeout(inst.annTimer);
		try {
			const names = [...new Set(inst.config.stations.flatMap((s) => (s.lines || []).map((r) => r.line)))];
			const res = await inst.client.call("getAnnouncements", {
				...(names.length ? { names } : {}),
				full: true,
				filterPlanned: "NO_FILTER"
			});
			inst.announcements = inst.config.showAnnouncements ? relevantAnnouncements(res.announcements || [], inst.config) : [];
			// "<station index>|<line>" of stops that are temporarily relocated (for showRelocations)
			inst.relocated = new Set();
			const stops = inst.config.stations.flatMap((st, index) => (st.lines || []).map((r) => ({ key: `${index}|${r.line}`, station: st.name, name: st.name, lines: [r.line] })));
			for (const stop of mapData.markRelocations(stops, res.announcements || [])) if (stop.moved) inst.relocated.add(stop.key);
			this.sendSocketNotification("HVV_ANNOUNCEMENTS", { identifier: inst.identifier, announcements: inst.announcements });
		} catch (error) {
			Log.warn(`announcements: ${error.message}`);
		}
		if (!inst.suspended) {
			inst.annTimer = setTimeout(() => this.updateAnnouncements(inst), inst.config.announcementInterval * 1000);
		}
	}
});
