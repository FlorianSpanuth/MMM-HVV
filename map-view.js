/* MMM-HVV – map view renderer (browser)
 *
 * Draws the map as SVG: streets (grey strokes, no labels), colored line paths, stations, bus stops
 * at their real position, home, and live vehicles moving along their track. Coordinates are
 * projected with Web Mercator and fitted into the element's size; it re-fits on resize.
 */
/* exported HvvMapView */
class HvvMapView {
	static LINE_COLORS = {
		"hvv-u1": "#006ab3", "hvv-u2": "#e2021b", "hvv-u3": "#fddd00", "hvv-u4": "#0098a1", "hvv-u5": "#b5a1cf",
		"hvv-s": "#009252", "hvv-akn": "#ee7f00", "hvv-r": "#9a9a9a", "hvv-metrobus": "#ff4a4a", "hvv-bus": "#ff6b6b",
		"hvv-xpress": "#1a9e4c", "hvv-nightbus": "#3b6fd1", "hvv-ferry": "#0091d3"
	};

	static ROAD_STYLE = { 3: ["#8a8a8a", 4.5], 2: ["#6e6e6e", 3.2], 1: ["#4f4f4f", 2.2], 0: ["#333", 1.2], "-1": ["#242424", 0.8] };

	constructor(root, legend, { lineClass, translate, showLegend = true, showAttribution = false }) {
		this.root = root;
		this.legend = legend;
		this.lineClass = lineClass;
		this.translate = translate;
		this.showLegend = showLegend;
		this.showAttribution = showAttribution;
		this.map = null;
		this.vehicles = [];
		this.ns = "http://www.w3.org/2000/svg";

		this.svg = document.createElementNS(this.ns, "svg");
		this.svg.classList.add("hvv-map-svg");
		this.root.appendChild(this.svg);

		new ResizeObserver(() => this.draw()).observe(this.root);
		// move vehicles with the display's refresh rate (paused by the browser when not visible)
		const frame = () => {
			this.moveVehicles();
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
	}

	setMap(map) {
		this.map = map;
		this.draw();
	}

	setVehicles(vehicles) {
		this.vehicles = vehicles;
		this.drawVehicles();
	}

	// --- projection --------------------------------------------------------------------------

	merc(lat, lng) {
		return [(lng * Math.PI) / 180, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
	}

	fit() {
		const w = this.root.clientWidth;
		const h = this.root.clientHeight;
		const { south, west, north, east } = this.map.area;
		const [x0, y0] = this.merc(south, west);
		const [x1, y1] = this.merc(north, east);
		const scale = Math.min(w / (x1 - x0), h / (y1 - y0));
		const cx = (x0 + x1) / 2;
		const cy = (y0 + y1) / 2;
		this.size = [w, h];
		this.project = (lat, lng) => {
			const [x, y] = this.merc(lat, lng);
			return [w / 2 + (x - cx) * scale, h / 2 - (y - cy) * scale];
		};
	}

	pathData(points) {
		return points.map(([lat, lng], i) => {
			const [x, y] = this.project(lat, lng);
			return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
		}).join("");
	}

	el(tag, attrs = {}, parent = this.svg) {
		const e = document.createElementNS(this.ns, tag);
		for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
		parent.appendChild(e);
		return e;
	}

	color(item) {
		return HvvMapView.LINE_COLORS[this.lineClass(item)] || "#aaa";
	}

	// --- static layers ---------------------------------------------------------------------------

	draw() {
		if (!this.map || !this.root.clientWidth || !this.root.clientHeight) return;
		this.fit();
		// scale symbols, strokes and text with the mirror's font size (20px = 1)
		const k = (this.k = parseFloat(getComputedStyle(this.root).fontSize) / 20 || 1);
		const [w, h] = this.size;
		this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
		this.svg.replaceChildren();

		// streets: one path per class, quietest first
		for (const c of [-1, 0, 1, 2, 3]) {
			const d = this.map.roads.filter((r) => r.c === c).map((r) => this.pathData(r.p)).join("");
			const [stroke, width] = HvvMapView.ROAD_STYLE[c];
			if (d) this.el("path", { d, fill: "none", stroke, "stroke-width": width * k, "stroke-linecap": "round", "stroke-linejoin": "round" });
		}

		// line paths: rail lines once (both directions run on the same track), buses in both directions
		// (they often use different streets, e.g. one-way streets or detours); buses dashed
		const byLine = new Map();
		for (const line of this.map.lines) {
			const len = line.parts.reduce((a, p) => a + p.length, 0);
			const key = line.type === "BUS" ? `${line.line}|${byLine.size}` : line.line;
			if (!byLine.has(key) || len > byLine.get(key).len) byLine.set(key, { line, len });
		}
		for (const { line } of byLine.values()) {
			const d = line.parts.map((p) => this.pathData(p)).join("");
			const bus = line.type === "BUS";
			this.el("path", { d, fill: "none", stroke: "#000", "stroke-width": (bus ? 7 : 9) * k, "stroke-opacity": 0.6, "stroke-linecap": "round", "stroke-linejoin": "round" });
			this.el("path", { d, fill: "none", stroke: this.color(line), "stroke-width": (bus ? 3.5 : 5) * k, "stroke-opacity": 0.85, "stroke-dasharray": bus ? `${8 * k} ${6 * k}` : "none", "stroke-linecap": "round", "stroke-linejoin": "round" });
		}

		// bus stops where buses really stop (orange ring: temporarily relocated)
		for (const stop of this.map.stops) {
			const [x, y] = this.project(stop.lat, stop.lng);
			const g = this.el("g", { class: `hvv-map-busstop${stop.moved ? " moved" : ""}`, transform: `translate(${x} ${y}) scale(${k})` });
			this.el("circle", { r: 9 }, g);
			this.el("text", { y: 4 }, g).textContent = "H";
		}

		// stations: U/S symbol for rail stations, label for all
		for (const st of this.map.stations) {
			const [x, y] = this.project(st.lat, st.lng);
			const rail = st.types.find((t) => t === "u" || t === "s");
			if (!rail && st.types.includes("ship")) {
				const g = this.el("g", { class: "hvv-map-station ferry", transform: `translate(${x} ${y}) scale(${k})` });
				this.el("rect", { x: -11, y: -11, width: 22, height: 22, rx: 11 }, g);
				this.el("text", { y: 5 }, g).textContent = "F";
			}
			if (rail) {
				const g = this.el("g", { class: `hvv-map-station ${rail}`, transform: `translate(${x} ${y}) scale(${k})` });
				this.el("rect", { x: -11, y: -11, width: 22, height: 22, rx: rail === "s" ? 11 : 3 }, g);
				this.el("text", { y: 5 }, g).textContent = rail.toUpperCase();
			}
			const right = x > w * 0.65;
			const label = this.el("text", { class: "hvv-map-label", x: right ? x - 16 * k : x + 16 * k, y: y + 4 * k, "font-size": 13 * k, "stroke-width": 4 * k, "text-anchor": right ? "end" : "start" });
			label.textContent = st.name;
		}

		// home
		const [hx, hy] = this.project(this.map.home.lat, this.map.home.lng);
		const home = this.el("g", { class: "hvv-map-home", transform: `translate(${hx} ${hy}) scale(${k})` });
		this.el("circle", { r: 16 }, home);
		this.el("path", { d: "M-7 1 L0 -6 L7 1 M-5 -1 V7 H5 V-1", fill: "none", "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round" }, home);

		this.vehicleLayer = this.el("g", { class: "hvv-map-vehicles" });
		this.drawVehicles();
		this.drawLegend();
	}

	drawLegend() {
		if (!this.showLegend && !this.showAttribution) {
			this.legend.replaceChildren();
			return;
		}
		const items = [];
		if (this.showLegend) {
			const seen = new Set();
			for (const l of this.map.lines) {
				if (seen.has(l.line)) continue;
				seen.add(l.line);
				const style = l.type === "BUS" ? `background: repeating-linear-gradient(90deg, ${this.color(l)} 0 6px, transparent 6px 9px)` : `background: ${this.color(l)}`;
				items.push(`<span><i style="${style}"></i>${l.line}</span>`);
			}
			if (this.map.stops.some((s) => s.moved)) items.push(`<span><b class="hvv-map-moved-dot"></b>${this.translate("MOVED")}</span>`);
		}
		if (this.showAttribution) items.push(`<span class="hvv-map-attribution">${this.translate("MAP_ATTRIBUTION")}</span>`);
		this.legend.innerHTML = items.join("");
	}

	// --- vehicles ----------------------------------------------------------------------------------

	drawVehicles() {
		if (!this.vehicleLayer) return;
		this.vehicleLayer.replaceChildren();
		for (const v of this.vehicles) {
			// project tracks once and precompute cumulative lengths for interpolation
			v.screen = v.segments.map((s) => {
				const pts = s.track.map(([lat, lng]) => this.project(lat, lng));
				const cum = [0];
				for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
				return { ...s, pts, cum };
			});
			const cls = this.lineClass(v);
			v.node = this.el("g", { class: `hvv-map-vehicle ${v.type === "BUS" ? "bus" : "rail"}` }, this.vehicleLayer);
			const text = this.el("text", { y: 4 }, v.node);
			text.textContent = v.line;
			const width = Math.max(22, v.line.length * 8 + 8);
			const rect = this.el("rect", { x: -width / 2, y: -9, width, height: 18, rx: v.type === "BUS" ? 9 : 3, fill: HvvMapView.LINE_COLORS[cls] || "#aaa" }, v.node);
			v.node.insertBefore(rect, text);
			if (cls === "hvv-u3" || cls === "hvv-u5") text.setAttribute("fill", "#000");
		}
		this.moveVehicles();
	}

	position(v, now) {
		const segs = v.screen;
		if (!segs?.length) return null;
		if (now > segs.at(-1).t1 + 60000) return null; // gone
		let s = segs.find((x) => now >= x.t0 && now <= x.t1);
		if (!s) {
			const next = segs.find((x) => now < x.t0);
			s = next || segs.at(-1);
			const p = next ? s.pts[0] : s.pts.at(-1); // waiting at a stop
			return p;
		}
		if (s.pts.length < 2) return s.pts[0];
		const target = ((now - s.t0) / Math.max(1, s.t1 - s.t0)) * s.cum.at(-1);
		let i = s.cum.findIndex((d) => d >= target);
		if (i <= 0) return s.pts[0];
		const k = (target - s.cum[i - 1]) / (s.cum[i] - s.cum[i - 1] || 1);
		return [s.pts[i - 1][0] + (s.pts[i][0] - s.pts[i - 1][0]) * k, s.pts[i - 1][1] + (s.pts[i][1] - s.pts[i - 1][1]) * k];
	}

	moveVehicles() {
		if (!this.size) return;
		const now = Date.now();
		const [w, h] = this.size;
		for (const v of this.vehicles) {
			if (!v.node) continue;
			const p = this.position(v, now);
			const visible = p && p[0] > -20 && p[1] > -20 && p[0] < w + 20 && p[1] < h + 20;
			v.node.style.display = visible ? "" : "none";
			if (visible) v.node.setAttribute("transform", `translate(${p[0].toFixed(1)} ${p[1].toFixed(1)}) scale(${this.k})`);
		}
	}
}
