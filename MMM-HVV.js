/* MMM-HVV – Hamburg public transport departures for MagicMirror²
 *
 * view "departures": multiple stations, per-station line/direction filters, real-time delays,
 * a "when do I have to leave?" countdown based on your walking time, and relevant announcements.
 * view "routes": connections to your destinations (incl. transfers), only in the time windows you set.
 * view "map": live map around your home with your lines, stops and moving vehicles.
 * Each view is its own module instance – place and enable them independently. See README.md.
 */
Module.register("MMM-HVV", {
	defaults: {
		apiUser: "",
		apiKey: "",
		apiBase: "https://gti.geofox.de/gti/public/",
		view: "departures", // "departures" | "routes" | "map"

		// [{ id: "Master:11907", name: "Baumwall", walkTime: "4:00", lines: ["U3", { line: "111", direction: "Altona" }] }]
		stations: [],
		departuresPerStation: 3,
		maxTimeOffset: 60, // minutes ahead to look for departures

		// leave-time calculation
		buffer: 30, // seconds you want to be at the stop before departure
		hideUnreachable: true, // hide departures you can no longer catch on foot
		leaveTimeFor: "connection", // countdown for the next reachable departure per "connection" (line + direction), per "station", or "all"
		leaveSoon: 120, // seconds: highlight "leave in …" from here on

		timeFormat: "relative", // relative ("5 min") | absolute ("12:34") | both
		showDelay: true,
		showPlatform: false,
		showLineType: true, // colored line badges
		showRelocations: false, // mark departures from a temporarily relocated stop (orange dot)

		updateInterval: 60, // seconds between API requests
		quietHours: { from: "01:00", to: "05:00", interval: 900 }, // null to disable

		showAnnouncements: true,
		announcementScope: "stations", // "stations": only for your stations | "lines": everything on your lines
		announcementInterval: 600, // seconds
		maxAnnouncements: 2,

		// view "routes"
		// [{ name: "Airport", from: "Baumwall", to: "Hamburg Airport", walkTime: { default: "4:00", 111: "5:30" },
		//    when: { days: "mon-fri", from: "07:00", to: "09:30" }, options: 2 }]
		routes: [],
		routeInterval: 120, // seconds between requests per route when a departure is coming up
		routeIntervalFar: 300, // … and otherwise

		// view "map"
		home: "", // address ("Platz der Deutschen Einheit 1") or { lat, lng } – the map is centered around it and your stations
		height: "45vh", // any CSS height ("45vh", "500px") or per orientation: { portrait: "45vh", landscape: "30vh" }
		mapPadding: 0.3, // extra space around home + stations (fraction of the area)
		showLegend: true,
		showAttribution: false // "Map © OpenStreetMap" in the legend – turn on if the mirror is shown publicly (ODbL)
	},

	getStyles() {
		return ["MMM-HVV.css"];
	},

	getScripts() {
		return this.config.view === "map" ? ["map-view.js"] : [];
	},

	getTranslations() {
		return { en: "translations/en.json", de: "translations/de.json" };
	},

	start() {
		this.data.header ??= "HVV";
		this.stations = null;
		this.announcements = [];
		this.error = null;
		this.signature = "";
		this.normalized = this.normalizedConfig();
		this.sendSocketNotification("HVV_START", { identifier: this.identifier, config: this.normalized });
		this.ticker = setInterval(() => this.tick(), 1000);
	},

	// accept short forms in config.js: "U3", { line: "U3", direction: "Barmbek" | [...] }, walkTime "5:30" | 5.5
	normalizedConfig() {
		const c = this.config;
		return {
			...c,
			routes: c.routes.map((r) => ({
				name: r.name || r.to,
				from: String(r.from),
				to: String(r.to),
				when: r.when,
				options: r.options ?? 2,
				walkTime: parseWalkTimes(r.walkTime)
			})),
			stations: c.stations.map((s) => ({
				id: s.id,
				name: s.name || s.id,
				walkTime: parseDuration(s.walkTime),
				lines: [].concat(s.lines || []).map((r) =>
					typeof r === "object"
						? { line: String(r.line), direction: [].concat(r.direction || []).map(String), walkTime: r.walkTime === undefined ? undefined : parseDuration(r.walkTime) }
						: { line: String(r), direction: [] }
				)
			}))
		};
	},

	suspend() {
		this.sendSocketNotification("HVV_SUSPEND", { identifier: this.identifier });
	},

	resume() {
		this.sendSocketNotification("HVV_RESUME", { identifier: this.identifier });
	},

	socketNotificationReceived(notification, payload) {
		if (payload?.identifier !== this.identifier) return;
		if (notification === "HVV_MAP") {
			this.error = null;
			this.ensureMapView();
			this.mapView.setMap(payload);
			return;
		}
		if (notification === "HVV_VEHICLES") {
			this.requestCount = payload.requests;
			this.ensureMapView();
			this.mapView.setVehicles(payload.vehicles);
			return;
		}
		if (notification === "HVV_ROUTES") {
			this.routes = payload.routes;
			this.requestCount = payload.requests;
			this.error = null;
			// lets MMM-Director (or similar) hide the module while no route is active
			this.sendNotification("MM2_CONTENT", { hasContent: this.routes.length > 0 });
			this.render();
			return;
		}
		if (notification === "HVV_DATA") {
			this.stations = payload.stations;
			this.requestCount = payload.requests; // API requests since server start (for debugging)
			this.error = null;
			this.render();
		} else if (notification === "HVV_ANNOUNCEMENTS") {
			this.announcements = payload.announcements;
			this.render();
		} else if (notification === "HVV_ERROR") {
			this.error = payload.message;
			if (!this.stations) this.render();
		}
	},

	// --- computing what to show ------------------------------------------------------

	visibleRows(now = Date.now()) {
		const c = this.config;
		return (this.stations || []).map((station) => {
			const rows = [];
			const leaveShown = new Set(); // connections (or the station) that already have a countdown
			for (const dep of station.departures) {
				const walk = dep.walk ?? station.walkTime;
				const time = dep.cancelled ? dep.planned : dep.realtime;
				const reachable = time - walk >= now; // without buffer: last chance
				if (time < now - 30000) continue;
				if (walk && !reachable && c.hideUnreachable && !dep.cancelled) continue;
				let leave = null;
				const key = c.leaveTimeFor === "station" ? "station" : c.leaveTimeFor === "all" ? rows.length : `${dep.line}|${dep.directionId ?? dep.direction}`;
				if (walk && !dep.cancelled && reachable && !leaveShown.has(key)) {
					leave = time - walk - c.buffer * 1000;
					leaveShown.add(key);
				}
				rows.push({ dep, time, leave });
				if (rows.length >= c.departuresPerStation) break;
			}
			return { station, rows };
		});
	},

	visibleRouteRows(now = Date.now()) {
		const c = this.config;
		return (this.routes || []).map((route) => {
			const rows = [];
			for (const s of route.schedules) {
				const reachable = s.leaveBase - s.walk >= now;
				if (!reachable && c.hideUnreachable) continue;
				rows.push({ s, time: s.departure, leave: reachable ? s.leaveBase - s.walk - c.buffer * 1000 : null });
				if (rows.length >= (this.normalized.routes.find((r) => r.name === route.name)?.options ?? 2)) break;
			}
			return { route, rows };
		});
	},

	rowSignature() {
		if (this.config.view === "routes") {
			return this.visibleRouteRows()
				.map((r) => r.route.name + r.rows.map((x) => `${x.s.line}${x.s.departure}${x.leave !== null}`).join())
				.join("|");
		}
		return this.visibleRows()
			.map((s) => s.rows.map((r) => `${r.dep.line}${r.time}${r.leave !== null}`).join())
			.join("|");
	},

	// re-render only when the set of rows changes; otherwise just update the countdown texts
	tick() {
		if (!this.stations && !this.routes) return;
		if (this.rowSignature() !== this.signature) this.render();
		else this.updateTimes();
	},

	render() {
		this.signature = this.rowSignature();
		this.updateDom(0);
	},

	updateTimes() {
		const now = Date.now();
		this.wrapper?.querySelectorAll("[data-time]").forEach((el) => {
			el.textContent = this.formatDeparture(Number(el.dataset.time), now);
		});
		this.wrapper?.querySelectorAll("[data-leave]").forEach((el) => {
			const leave = Number(el.dataset.leave);
			el.textContent = this.formatLeave(leave, now);
			el.className = `hvv-leave ${this.leaveClass(leave, now)}`;
		});
	},

	// --- formatting ----------------------------------------------------------------------

	formatDeparture(time, now) {
		const mins = Math.floor((time - now) / 60000);
		const abs = this.clock(time);
		const rel = mins <= 0 ? this.translate("NOW") : this.translate("IN_MIN", { min: mins });
		if (this.config.timeFormat === "absolute") return abs;
		if (this.config.timeFormat === "both") return `${rel} · ${abs}`;
		return mins >= 60 ? abs : rel;
	},

	// wall-clock time, 24 h or 12 h as set in MagicMirror's timeFormat
	clock(t) {
		return new Date(t).toLocaleTimeString(config.locale || config.language, { hour: "2-digit", minute: "2-digit", hour12: config.timeFormat === 12 });
	},

	formatLeave(leave, now) {
		const s = Math.ceil((leave - now) / 1000);
		if (s <= 0) return this.translate("LEAVE_NOW");
		const mm = Math.floor(s / 60);
		const ss = String(s % 60).padStart(2, "0");
		return this.translate("LEAVE_IN", { time: `${mm}:${ss}` });
	},

	leaveClass(leave, now) {
		const s = (leave - now) / 1000;
		if (s <= 0) return "now";
		if (s <= this.config.leaveSoon) return "soon";
		return "later";
	},

	// --- DOM ---------------------------------------------------------------------------------

	// the map keeps its own DOM (SVG) – created once, MagicMirror re-renders don't touch it
	ensureMapView() {
		if (this.mapView) return;
		this.mapRoot = document.createElement("div");
		this.mapRoot.className = "hvv-map";
		const canvas = document.createElement("div");
		canvas.className = "hvv-map-canvas";
		const h = this.config.height;
		canvas.style.setProperty("--hvv-map-h-portrait", typeof h === "object" ? h.portrait : h);
		canvas.style.setProperty("--hvv-map-h-landscape", typeof h === "object" ? h.landscape ?? h.portrait : h);
		const legend = document.createElement("div");
		legend.className = "hvv-map-legend";
		this.mapRoot.append(canvas, legend);
		this.mapView = new HvvMapView(canvas, legend, {
			lineClass,
			translate: (k) => this.translate(k),
			showLegend: this.config.showLegend,
			showAttribution: this.config.showAttribution
		});
		this.updateDom(0);
	},

	getDom() {
		if (this.config.view === "map") {
			if (this.mapRoot) return this.mapRoot;
			const wrapper = document.createElement("div");
			wrapper.innerHTML = `<div class="dimmed small">${this.error ? `${this.translate("ERROR")}: ${escape(this.error)}` : this.translate("LOADING_MAP")}</div>`;
			return wrapper;
		}
		const wrapper = document.createElement("div");
		wrapper.className = "hvv";
		this.wrapper = wrapper;

		if (this.config.view === "routes" ? !this.routes : !this.stations) {
			wrapper.innerHTML = `<div class="dimmed small">${this.error ? `${this.translate("ERROR")}: ${escape(this.error)}` : this.translate("LOADING")}</div>`;
			return wrapper;
		}

		const now = Date.now();
		if (this.config.view === "routes") {
			this.renderRoutes(wrapper, now);
			return wrapper;
		}
		this.visibleRows(now).forEach(({ station, rows }, index) => {
			const block = document.createElement("div");
			block.className = "hvv-station";
			// walking time(s): station default and per-line overrides, e.g. "4:30–5 min walk"
			const cfg = this.normalized.stations[index];
			const walks = [...new Set([...cfg.lines.map((r) => r.walkTime ?? cfg.walkTime), ...(cfg.lines.length ? [] : [cfg.walkTime])].filter(Boolean))].sort((a, b) => a - b);
			const walkText = walks.length > 1 ? `${formatDuration(walks[0])}–${formatDuration(walks.at(-1))}` : walks.length ? formatDuration(walks[0]) : "";
			const walk = walkText ? `<span class="hvv-walk">${this.translate("WALK", { time: walkText })}</span>` : "";
			block.innerHTML = `<div class="hvv-station-name">${escape(station.name)}${walk}</div>`;

			if (!rows.length) {
				block.insertAdjacentHTML("beforeend", `<div class="hvv-empty dimmed xsmall">${this.translate("NO_DEPARTURES")}</div>`);
			}
			for (const { dep, time, leave } of rows) {
				const row = document.createElement("div");
				row.className = `hvv-row${dep.cancelled ? " cancelled" : ""}`;
				const delay = this.config.showDelay && dep.delay >= 60 ? `<span class="hvv-delay">+${Math.round(dep.delay / 60)}</span>` : "";
				const platform = dep.realtimePlatform
					? `<span class="hvv-platform changed">${escape(dep.realtimePlatform)}</span>`
					: this.config.showPlatform && dep.platform
						? `<span class="hvv-platform">${escape(dep.platform)}</span>`
						: "";
				const moved = this.config.showRelocations && dep.moved ? `<span class="hvv-moved" title="${this.translate("MOVED")}"></span>` : "";
				const note = dep.cancelled ? `<span class="hvv-note">${this.translate("CANCELLED")}</span>` : dep.extra ? `<span class="hvv-note extra">${this.translate("EXTRA")}</span>` : "";
				row.innerHTML = `
					<span class="hvv-line ${this.config.showLineType ? lineClass(dep) : ""}">${escape(dep.line)}</span>
					<span class="hvv-direction">${escape(dep.direction)}${moved}${platform}${note}</span>
					<span class="hvv-time"><span data-time="${time}">${this.formatDeparture(time, now)}</span>${delay}</span>
					${leave !== null ? `<span class="hvv-leave ${this.leaveClass(leave, now)}" data-leave="${leave}">${this.formatLeave(leave, now)}</span>` : `<span class="hvv-leave"></span>`}`;
				block.appendChild(row);
			}
			wrapper.appendChild(block);
		});

		if (this.config.showAnnouncements && this.announcements.length) {
			const box = document.createElement("div");
			box.className = "hvv-announcements";
			for (const a of this.announcements) {
				const lines = a.lines.length ? `<span class="hvv-ann-lines">${a.lines.map(escape).join(", ")}</span>` : "";
				box.insertAdjacentHTML("beforeend", `<div class="hvv-announcement${a.planned ? "" : " unplanned"}">⚠ ${lines}${escape(a.summary)}</div>`);
			}
			wrapper.appendChild(box);
		}
		return wrapper;
	},

	// U3 → U1 as small colored badges; walks between stops as a walking icon
	chainHtml(s) {
		const chain = s.chain?.length ? s.chain : [{ line: s.line, type: s.type, info: s.info }];
		const shown = chain.length > 5 ? [...chain.slice(0, 4), { more: chain.length - 4 }] : chain;
		return shown
			.map((leg) => {
				if (leg.walk) return `<span class="hvv-walkleg" title="walk">${WALK_ICON}</span>`;
				if (leg.more) return `<span class="hvv-more">+${leg.more}</span>`;
				return `<span class="hvv-line ${this.config.showLineType ? lineClass(leg) : ""}">${escape(leg.line)}</span>`;
			})
			.join(`<span class="hvv-arrow">›</span>`);
	},

	renderRoutes(wrapper, now) {
		const timeOf = (t) => this.clock(t);
		for (const { route, rows } of this.visibleRouteRows(now)) {
			const block = document.createElement("div");
			block.className = "hvv-station hvv-route";
			block.innerHTML = `<div class="hvv-station-name">${escape(route.name)}</div>`;
			if (!rows.length) {
				block.insertAdjacentHTML("beforeend", `<div class="hvv-empty dimmed xsmall">${this.translate("NO_CONNECTIONS")}</div>`);
			}
			for (const { s, time, leave } of rows) {
				const row = document.createElement("div");
				row.className = "hvv-row hvv-route-row";
				const delay = this.config.showDelay && s.delay >= 60 ? `<span class="hvv-delay">+${Math.round(s.delay / 60)}</span>` : "";
				const late = s.arrivalDelay >= 60000 ? " late" : "";
				// boarding stop only if it isn't just the origin again (e.g. "Baumwall (Elbphilharmonie)" for "Baumwall")
				const board = route.origin && s.boardAt.includes(route.origin) ? "" : `<span class="hvv-board">${escape(s.boardAt)}</span>`;
				row.innerHTML = `
					<span class="hvv-chain">${this.chainHtml(s)}</span>
					<span class="hvv-direction">${board}<span class="hvv-arrival${late}">${this.translate("ARRIVE", { time: timeOf(s.arrival) })}</span></span>
					<span class="hvv-time"><span data-time="${time}">${this.formatDeparture(time, now)}</span>${delay}</span>
					${leave !== null ? `<span class="hvv-leave ${this.leaveClass(leave, now)}" data-leave="${leave}">${this.formatLeave(leave, now)}</span>` : `<span class="hvv-leave"></span>`}`;
				block.appendChild(row);
			}
			wrapper.appendChild(block);
		}
	}
});

// small walking figure (inline SVG, no icon font needed)
const WALK_ICON =
	'<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M10.5 8.5 8 10v3.5h1.8v-2.4l1.2-.7-1.4 7.1L6.8 21l1.4 1.1 3.4-3.4.9-3.6 2 2V22h1.8v-5.5l-2-2 .6-3 1.4 1.8H19v-1.8h-2.2l-2.4-3.2A2 2 0 0 0 12.8 7.5Z"/></svg>';

// walkTime: "4:30" | 4.5 | { default: "4:30", U2: "5:00" } → { default: ms, lines: { U2: ms } }
function parseWalkTimes(v) {
	if (v && typeof v === "object") {
		const lines = {};
		for (const [k, t] of Object.entries(v)) if (k !== "default") lines[k] = parseDuration(t);
		return { default: parseDuration(v.default), lines };
	}
	return { default: parseDuration(v), lines: {} };
}

// --- helpers ------------------------------------------------------------------------------

// "5:30" → 330000 ms, 5.5 → 330000 ms, "90s" → 90000 ms
function parseDuration(v) {
	if (v === undefined || v === null || v === "") return 0;
	if (typeof v === "number") return Math.round(v * 60000);
	const s = String(v).trim();
	if (/^\d+s$/.test(s)) return Number(s.slice(0, -1)) * 1000;
	const [m, sec = 0] = s.split(":").map(Number);
	return (m * 60 + sec) * 1000;
}

function formatDuration(ms) {
	const s = Math.round(ms / 1000);
	return s % 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s / 60}`;
}

function lineClass(dep) {
	const name = dep.line.toUpperCase();
	const info = dep.info.toLowerCase();
	if (/^U\d/.test(name)) return `hvv-${name.toLowerCase()}`;
	if (/^S\d/.test(name)) return "hvv-s";
	if (/^A\d/.test(name)) return "hvv-akn";
	if (/^R/.test(name) || dep.type === "TRAIN") return "hvv-r";
	if (dep.type === "SHIP" || info.includes("fähre")) return "hvv-ferry";
	if (info.includes("nacht")) return "hvv-nightbus";
	if (info.includes("xpress") || info.includes("schnell")) return "hvv-xpress";
	if (info.includes("metrobus")) return "hvv-metrobus";
	return "hvv-bus";
}

function escape(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
