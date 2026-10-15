/* Minimal client for the HVV Geofox Thin Interface (GTI).
 * API docs: https://gti.geofox.de/html/GTIHandbuch_p.html
 *
 * Authentication: HMAC-SHA1 of the request body, keyed with the API password,
 * sent base64-encoded in the geofox-auth-signature header.
 */
const crypto = require("node:crypto");

const DEFAULT_BASE_URL = "https://gti.geofox.de/gti/public/";
const API_VERSION = 63;
const MIN_GAP_MS = 300; // between two requests, across all module instances
const RETRY_AFTER_MS = 3000;

// One queue for all requests of this process: on start, several views would otherwise fire
// a burst of requests at once – the GTI answers bursts with "A technical problem occured".
let queue = Promise.resolve();
let lastRequest = 0;
function throttled(fn) {
	const run = queue.then(async () => {
		const wait = lastRequest + MIN_GAP_MS - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastRequest = Date.now();
		return fn();
	});
	queue = run.catch(() => {});
	return run;
}

class GtiError extends Error {
	constructor(message, { status, returnCode } = {}) {
		super(message);
		this.name = "GtiError";
		this.status = status;
		this.returnCode = returnCode;
	}
}

class GtiClient {
	constructor({ user, key, baseUrl = DEFAULT_BASE_URL, timeoutMs = 15000, userAgent = "MMM-HVV" }) {
		if (!user || !key) throw new GtiError("apiUser and apiKey are required");
		this.user = user;
		this.key = key;
		this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
		this.timeoutMs = timeoutMs;
		this.userAgent = userAgent;
		this.requestCount = 0;
	}

	sign(body) {
		return crypto.createHmac("sha1", this.key).update(body, "utf8").digest("base64");
	}

	async call(method, payload = {}) {
		try {
			return await throttled(() => this.request(method, payload));
		} catch (error) {
			// transient server-side error: one retry after a short pause
			if (error.returnCode !== "ERROR_TEXT" && !(error.status >= 500)) throw error;
			await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
			return throttled(() => this.request(method, payload));
		}
	}

	async request(method, payload) {
		const body = JSON.stringify({ version: API_VERSION, ...payload });
		this.requestCount++;
		let res;
		try {
			res = await fetch(this.baseUrl + method, {
				method: "POST",
				headers: {
					"Content-Type": "application/json;charset=UTF-8",
					Accept: "application/json",
					"User-Agent": this.userAgent,
					"geofox-auth-type": "HmacSHA1",
					"geofox-auth-user": this.user,
					"geofox-auth-signature": this.sign(body)
				},
				body,
				signal: AbortSignal.timeout(this.timeoutMs)
			});
		} catch (error) {
			throw new GtiError(`${method}: ${error.name === "TimeoutError" ? "timeout" : error.message}`);
		}
		let data;
		try {
			data = await res.json();
		} catch {
			throw new GtiError(`${method}: HTTP ${res.status}, no JSON response`, { status: res.status });
		}
		if (!res.ok || data.returnCode !== "OK") {
			const text = [data.errorText, data.errorDevInfo].filter(Boolean).join(" / ") || res.statusText;
			throw new GtiError(`${method}: ${data.returnCode || `HTTP ${res.status}`} – ${text}`, { status: res.status, returnCode: data.returnCode });
		}
		return data;
	}
}

module.exports = { GtiClient, GtiError };
