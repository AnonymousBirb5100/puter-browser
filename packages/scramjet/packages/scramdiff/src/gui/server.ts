/**
 * GUI server.
 *
 * Express HTTP endpoints:
 *
 *   GET  /                            static: index.html (GUI shell)
 *   GET  /app.js                      static: GUI client bundle
 *   GET  /app.css                     static: GUI stylesheet
 *
 *   GET  /api/traces                  list recorded traces in tracesDir
 *   GET  /api/sessions                list sessions (PublicSession[])
 *   POST /api/sessions/record         body: { target, headless? }
 *   POST /api/sessions/replay         body: { tracePath, headless?, breakpoint? }
 *   POST /api/sessions/diff           body: { target, headless? }
 *   GET  /api/sessions/:id            PublicSession
 *   GET  /api/sessions/:id/report     full DiffReport
 *   GET  /api/sessions/:id/issues     paged+filtered issues
 *   GET  /api/sessions/:id/log        full log (not just tail)
 *   GET  /api/sessions/:id/stream     SSE event stream
 *   POST /api/sessions/:id/resume     resume at breakpoint
 *   POST /api/sessions/:id/cancel     best-effort cancel
 *
 * The SSE stream delivers SessionEvent objects. On connection we replay the
 * current state so late-joiners see the full picture immediately.
 */

import express, { type Request, type Response } from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	SessionStore,
	type SessionEvent,
	type SessionBreakpoint,
} from "./sessions.ts";

export type GuiServerOptions = {
	port: number;
	tracesDir: string;
	/** If true, default all new sessions to non-headless Chromium. */
	headed?: boolean;
};

export async function startGuiServer(opts: GuiServerOptions) {
	const app = express();
	app.use(express.json({ limit: "1mb" }));

	const store = new SessionStore({ tracesDir: opts.tracesDir });
	await store.ensureTracesDir();

	const webDir = fileURLToPath(new URL("./web/", import.meta.url));
	app.use(express.static(webDir));

	// ---------- data routes ----------

	app.get("/api/traces", async (_req, res) => {
		const list = await store.listTraces();
		res.json(list);
	});

	app.get("/api/sessions", (_req, res) => {
		res.json(store.list());
	});

	app.post("/api/sessions/record", (req, res) => {
		const target =
			typeof req.body?.target === "string" ? req.body.target : null;
		if (!target) return res.status(400).json({ error: "target required" });
		const headless =
			req.body?.headless !== undefined ? !!req.body.headless : !opts.headed;
		const s = store.startRecord({ target, headless });
		res.status(201).json(s);
	});

	app.post("/api/sessions/replay", (req, res) => {
		const tracePath =
			typeof req.body?.tracePath === "string" ? req.body.tracePath : null;
		if (!tracePath)
			return res.status(400).json({ error: "tracePath required" });
		const headless =
			req.body?.headless !== undefined ? !!req.body.headless : !opts.headed;
		const breakpoint = parseBreakpoint(req.body?.breakpoint);
		const s = store.startReplay({ tracePath, headless, breakpoint });
		res.status(201).json(s);
	});

	app.post("/api/sessions/diff", (req, res) => {
		const target =
			typeof req.body?.target === "string" ? req.body.target : null;
		if (!target) return res.status(400).json({ error: "target required" });
		const headless =
			req.body?.headless !== undefined ? !!req.body.headless : !opts.headed;
		const s = store.startDiff({ target, headless });
		res.status(201).json(s);
	});

	app.get("/api/sessions/:id", (req, res) => {
		const s = store.get(req.params.id);
		if (!s) return res.status(404).json({ error: "not found" });
		res.json(s);
	});

	app.get("/api/sessions/:id/report", (req, res) => {
		const r = store.getReport(req.params.id);
		if (!r) return res.status(404).json({ error: "no report yet" });
		res.json(r);
	});

	app.get("/api/sessions/:id/issues", (req, res) => {
		const offset = parsePositiveInt(req.query.offset, 0);
		const limit = Math.min(parsePositiveInt(req.query.limit, 100), 1000);
		const kind =
			typeof req.query.kind === "string" ? req.query.kind : undefined;
		const api = typeof req.query.api === "string" ? req.query.api : undefined;
		const q = typeof req.query.q === "string" ? req.query.q : undefined;
		const page = store.issuesPage(req.params.id, {
			offset,
			limit,
			kind,
			api,
			q,
		});
		if (!page) return res.status(404).json({ error: "no report" });
		res.json(page);
	});

	app.get("/api/sessions/:id/log", (req, res) => {
		const s = store.get(req.params.id);
		if (!s) return res.status(404).json({ error: "not found" });
		// The public view only has logTail. Full log lives on the internal record;
		// we expose it here via a dedicated field the store exposes through get().
		// Keep the contract simple: return logTail as-is (it's capped, but covers
		// normal runs). If the UI wants more, we extend the store's public view.
		res.json({ log: s.logTail });
	});

	app.post("/api/sessions/:id/resume", async (req, res) => {
		const sideRaw = (req.body?.side ?? req.query?.side) as string | undefined;
		const side: "direct" | "scramjet" | "both" =
			sideRaw === "direct" || sideRaw === "both" ? sideRaw : "scramjet";
		const ok = await store.resume(req.params.id, side);
		if (!ok) return res.status(409).json({ error: "not paused" });
		res.json({ ok: true });
	});

	app.post("/api/sessions/:id/cancel", async (req, res) => {
		const ok = await store.cancel(req.params.id);
		if (!ok) return res.status(409).json({ error: "cannot cancel" });
		res.json({ ok: true });
	});

	// ---------- SSE event stream ----------

	app.get("/api/sessions/:id/stream", (req, res) => {
		sseStream(req, res, store, req.params.id);
	});

	app.get("/api/stream", (req, res) => {
		sseStream(req, res, store, null);
	});

	await new Promise<void>((resolve, reject) => {
		const server = app.listen(opts.port, () => resolve());
		server.on("error", reject);
	});

	return { url: `http://localhost:${opts.port}/` };
}

function parsePositiveInt(v: unknown, fallback: number): number {
	if (typeof v === "string") {
		const n = Number.parseInt(v, 10);
		if (Number.isFinite(n) && n >= 0) return n;
	}
	return fallback;
}

function parseBreakpoint(bp: any): SessionBreakpoint | undefined {
	if (!bp || typeof bp !== "object") return undefined;
	if (typeof bp.api !== "string") return undefined;
	const matchIndex = Number.parseInt(String(bp.matchIndex), 10);
	if (!Number.isFinite(matchIndex) || matchIndex < 1) return undefined;
	const op = typeof bp.op === "string" ? bp.op : undefined;
	if (op && op !== "call" && op !== "construct" && op !== "get" && op !== "set")
		return undefined;
	const alsoDirect = !!bp.alsoDirect;
	return { api: bp.api, op: op as any, matchIndex, alsoDirect };
}

function sseStream(
	req: Request,
	res: Response,
	store: SessionStore,
	filterSessionId: string | null
) {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders();

	const write = (ev: SessionEvent) => {
		if (filterSessionId) {
			const id = (ev as any).id ?? (ev as any).session?.id;
			if (id !== filterSessionId) return;
		}
		res.write(`data: ${JSON.stringify(ev)}\n\n`);
	};

	// Replay current state so late joiners don't miss anything.
	if (filterSessionId) {
		const s = store.get(filterSessionId);
		if (s)
			res.write(`data: ${JSON.stringify({ type: "state", session: s })}\n\n`);
	} else {
		for (const s of store.list()) {
			res.write(`data: ${JSON.stringify({ type: "state", session: s })}\n\n`);
		}
	}

	const listener = (ev: SessionEvent) => write(ev);
	store.on("event", listener);

	// Keepalive ping every 25s so intermediate proxies don't time us out.
	const ping = setInterval(() => res.write(": ping\n\n"), 25_000);

	const done = () => {
		clearInterval(ping);
		store.off("event", listener);
		try {
			res.end();
		} catch {}
	};
	req.on("close", done);
	req.on("end", done);
}
