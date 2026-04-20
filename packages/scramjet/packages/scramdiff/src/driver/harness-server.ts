/**
 * Self-contained scramjet harness server.
 *
 * Scramdiff owns its own scramjet runtime end-to-end. We do not depend on any
 * externally-running scramjet harness; relying on a process we don't control
 * introduces version drift, port conflicts, SW cache staleness, and timing
 * variability that would contaminate the diff signal. The whole point of the
 * oracle is determinism, so the oracle owns the stack.
 *
 * What this spins up:
 *
 *   - An HTTP server on a random loopback port serving:
 *       /scramjet/*   → scramjet's dist/ (scramjet.js, .wasm, etc.)
 *       /controller/* → scramjet-controller's dist/
 *       /libcurl/*    → libcurl-transport's dist/
 *       /sw.js        → scramjet service worker bootstrap (from src/driver/public)
 *       /*            → the bootstrap page (index.html) that registers the SW,
 *                       initializes the controller+transport, and exposes
 *                       window.__scramdiffEncode(url) for the driver to call.
 *
 *   - A wisp server on a *second* random loopback port for LibcurlClient's
 *     transport. Scramjet's SW opens a WebSocket here to proxy egress.
 *
 * Both ports are allocated by passing 0 to listen(); the runtime addr is read
 * back via server.address() and embedded in the bootstrap HTML so the page
 * can connect to wisp without any configuration baked into the repo.
 */

import express from "express";
import type { AddressInfo } from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

/**
 * Resolve a package's on-disk dist directory without assuming a hoisted layout.
 * We resolve the package's main entry (which every one of scramjet / controller
 * / libcurl-transport sets to something inside dist/) and take its dirname.
 * Works regardless of pnpm's symlink topology and of whether the package ships
 * an `exports` field.
 */
function resolvePackageDist(pkg: string): string {
	// Prefer the main entry when accessible.
	try {
		const entryPath = require_.resolve(pkg);
		return path.dirname(entryPath);
	} catch {
		// Fall back to package.json resolution if the main entry is restricted.
		const pjson = require_.resolve(`${pkg}/package.json`);
		return path.join(path.dirname(pjson), "dist");
	}
}

export type HarnessServer = {
	/** e.g. http://127.0.0.1:54123 */
	rootUrl: string;
	/** e.g. ws://127.0.0.1:54124/ */
	wispUrl: string;
	close(): Promise<void>;
};

export async function startHarnessServer(): Promise<HarnessServer> {
	const scramjetDist = resolvePackageDist("@mercuryworkshop/scramjet");
	const controllerDist = resolvePackageDist(
		"@mercuryworkshop/scramjet-controller"
	);
	const libcurlDist = resolvePackageDist("@mercuryworkshop/libcurl-transport");

	const publicDir = path.join(__dirname, "public");

	const app = express();

	// cache-control off — we want fresh files every run; scramjet dist is tiny
	// and stale SW caching between runs would silently diverge the two runs.
	const noCache: express.RequestHandler = (_req, res, next) => {
		res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
		res.setHeader("Pragma", "no-cache");
		res.setHeader("Expires", "0");
		next();
	};

	app.use(noCache);
	app.use("/scramjet", express.static(scramjetDist));
	app.use("/controller", express.static(controllerDist));
	app.use("/libcurl", express.static(libcurlDist));
	// Serve the bootstrap under a recognizable path that the probe matches on
	// to skip wrapping (so scramjet's own load isn't broken by our wrappers).
	// sw.js has to remain at the root for it to claim the whole origin scope.
	app.get("/__scramdiff_harness_bootstrap", (_req, res) =>
		res.sendFile(path.join(publicDir, "index.html"))
	);
	app.use(express.static(publicDir));

	// Start wisp on its own port first so we can bake the URL into the bootstrap.
	const wispServer = http.createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("scramdiff wisp");
	});
	wisp.options.allow_private_ips = true;
	wisp.options.allow_loopback_ips = true;
	logging.set_level(logging.NONE);
	wispServer.on("upgrade", (req, socket, head) => {
		wisp.routeRequest(req, socket, head);
	});

	const wispPort = await listenRandom(wispServer);
	const wispUrl = `ws://127.0.0.1:${wispPort}/`;

	// Inject the wisp URL into the bootstrap page as a global before any other
	// script runs, so the client-side code can read it deterministically.
	app.get("/_scramdiff_config.js", (_req, res) => {
		res.type("application/javascript");
		res.send(`window.__SCRAMDIFF_WISP_URL__ = ${JSON.stringify(wispUrl)};\n`);
	});

	const httpServer = http.createServer(app);
	const httpPort = await listenRandom(httpServer);
	const rootUrl = `http://127.0.0.1:${httpPort}`;

	return {
		rootUrl,
		wispUrl,
		async close() {
			await new Promise<void>((r) => httpServer.close(() => r()));
			await new Promise<void>((r) => wispServer.close(() => r()));
		},
	};
}

function listenRandom(server: http.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo | null;
			if (!addr) return reject(new Error("no address"));
			resolve(addr.port);
		});
	});
}
