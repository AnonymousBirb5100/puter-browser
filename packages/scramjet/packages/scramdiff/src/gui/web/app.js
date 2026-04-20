// scramdiff GUI — vanilla ESM, no build step.
//
// Two views (hash-based routing):
//   #/                 home (traces + sessions + create actions)
//   #/session/<id>     session detail (live stream + virtualized issue list)
//
// Global SSE stream (/api/stream) feeds the session tabs + home list so every
// view sees live updates. Session view opens its own /api/sessions/:id/stream
// for finer-grained events (paused, completed, etc).
//
// The issue list is virtualized: rows are absolute-positioned inside a
// height-sized spacer, and only visible rows are rendered on scroll. Handles
// hundreds of thousands of rows without slowing down.

const $view = document.getElementById("view");
const $tabs = document.getElementById("session-tabs");
const $modal = document.getElementById("modal-root");

const ROW_HEIGHT = 28; // keep in sync with .issue-row height in app.css
const PAGE_SIZE = 500; // how many issues to fetch per page from /api/sessions/:id/issues

// Shared global state.
const state = {
	sessions: new Map(), // id -> PublicSession
	traces: [],
	currentSession: null, // full session detail when viewing
	currentIssues: {
		offset: 0,
		total: 0,
		list: [], // sparse array, indexed by global issue offset
		pendingPages: new Set(),
		filter: { kind: null, api: null, q: "" },
	},
	currentIssueDetail: null,
};

// ---------- SSE plumbing ----------

function connectGlobalStream() {
	const es = new EventSource("/api/stream");
	es.addEventListener("message", (e) => {
		try {
			const ev = JSON.parse(e.data);
			handleGlobalEvent(ev);
		} catch {}
	});
	es.addEventListener("error", () => {
		// EventSource auto-reconnects; nothing to do.
	});
}

function handleGlobalEvent(ev) {
	if (ev.type === "state") {
		state.sessions.set(ev.session.id, ev.session);
		renderTabs();
		// On the home view, re-render session list; on session detail, refresh the header if matching.
		if (getRoute().name === "home") renderHome();
		if (getRoute().name === "session" && getRoute().id === ev.session.id) {
			state.currentSession = ev.session;
			updateSessionChrome();
			if (
				ev.session.status === "completed" &&
				!state.currentSession._loadedReport
			) {
				// The completed session now has a full report; reload the issue list.
				state.currentSession._loadedReport = true;
				state.currentIssues = {
					offset: 0,
					total: 0,
					list: [],
					pendingPages: new Set(),
					filter: state.currentIssues.filter,
				};
				loadIssuesAround(0);
				loadFacets();
			}
		}
	}
}

// ---------- router ----------

function getRoute() {
	const hash = location.hash || "#/";
	if (hash.startsWith("#/session/")) {
		return { name: "session", id: hash.slice("#/session/".length) };
	}
	return { name: "home" };
}

window.addEventListener("hashchange", renderRoute);

async function renderRoute() {
	closeDetailDrawer();
	const route = getRoute();
	if (route.name === "session") {
		await renderSession(route.id);
	} else {
		await renderHome();
	}
}

// ---------- tabs ----------

function renderTabs() {
	const active = Array.from(state.sessions.values())
		.filter((s) => s.status === "running" || s.status === "paused")
		.sort((a, b) =>
			(b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt)
		);
	$tabs.innerHTML = "";
	for (const s of active) {
		const a = document.createElement("a");
		a.className = "session-tab";
		a.dataset.status = s.status;
		a.href = `#/session/${s.id}`;
		a.innerHTML = `<span class="dot"></span>${escapeHtml(shortLabel(s))}`;
		$tabs.appendChild(a);
	}
}

function shortLabel(s) {
	const kind = s.mode[0].toUpperCase() + s.mode.slice(1);
	const t = s.target.replace(/^https?:\/\//, "");
	return `${kind}: ${t.length > 30 ? t.slice(0, 30) + "…" : t}`;
}

// ---------- home view ----------

async function renderHome() {
	await Promise.all([refreshSessions(), refreshTraces()]);
	const sessions = Array.from(state.sessions.values()).sort((a, b) =>
		b.createdAt.localeCompare(a.createdAt)
	);

	$view.innerHTML = `
		<div class="row">
			<button class="primary" id="btn-record">Record new trace…</button>
			<button class="primary" id="btn-diff">Live diff…</button>
			<button id="btn-replay-from-file">Replay existing trace…</button>
			<div class="spacer"></div>
			<button id="btn-refresh">↻ refresh</button>
		</div>
		<div class="home-grid">
			<div class="card">
				<h2>Traces</h2>
				<div class="card-body">
					${renderTraceList(state.traces)}
				</div>
			</div>
			<div class="card">
				<h2>Sessions</h2>
				<div class="card-body">
					${renderSessionList(sessions)}
				</div>
			</div>
		</div>
	`;

	document
		.getElementById("btn-record")
		.addEventListener("click", () => openNewRecordModal());
	document
		.getElementById("btn-diff")
		.addEventListener("click", () => openNewDiffModal());
	document
		.getElementById("btn-replay-from-file")
		.addEventListener("click", () => openReplaySelectModal());
	document.getElementById("btn-refresh").addEventListener("click", renderRoute);

	$view.querySelectorAll("[data-replay-path]").forEach((el) => {
		el.addEventListener("click", () =>
			startReplay({ tracePath: el.dataset.replayPath })
		);
	});
}

function renderTraceList(traces) {
	if (traces.length === 0) {
		return `<div style="color:var(--fg-dim);padding:8px">No traces yet. Click “Record new trace…” to create one.</div>`;
	}
	return `
		<ul class="trace-list">
			${traces
				.map(
					(t) => `
				<li>
					<div class="name" title="${escapeHtml(t.path)}">${escapeHtml(t.name)}</div>
					<div class="meta">${escapeHtml(t.target ?? "?")}</div>
					<div class="meta">${(t.size / 1024).toFixed(0)} kB</div>
					<div class="meta">${fmtDate(t.mtime)}</div>
					<button data-replay-path="${escapeHtml(t.path)}">replay →</button>
				</li>
			`
				)
				.join("")}
		</ul>
	`;
}

function renderSessionList(sessions) {
	if (sessions.length === 0) {
		return `<div style="color:var(--fg-dim);padding:8px">No sessions yet.</div>`;
	}
	return `
		<ul class="session-list">
			${sessions
				.map(
					(s) => `
				<li>
					<span class="status-badge ${s.status}">${s.status}</span>
					<span style="min-width:64px;color:var(--fg-dim);text-transform:uppercase;font-size:10px">${s.mode}</span>
					<a class="target" href="#/session/${s.id}">${escapeHtml(s.target)}</a>
					<span class="issues">${s.hasReport ? s.issueCount + " issues" : s.progress || ""}</span>
				</li>
			`
				)
				.join("")}
		</ul>
	`;
}

// ---------- session view ----------

async function renderSession(id) {
	const res = await fetch(`/api/sessions/${id}`);
	if (!res.ok) {
		$view.innerHTML = `<div class="card"><h2>Session not found</h2></div>`;
		return;
	}
	const session = await res.json();
	state.currentSession = session;
	state.currentIssues = {
		offset: 0,
		total: 0,
		list: [],
		pendingPages: new Set(),
		filter: { kind: null, api: null, q: "" },
	};

	$view.innerHTML = `
		<div class="session-view">
			<div id="session-chrome"></div>
			<div class="card" id="log-card" style="display:${session.status === "running" || session.status === "pending" ? "block" : "none"}">
				<h2>Log</h2>
				<div class="log-pane" id="log-pane"></div>
			</div>
			<div class="issue-pane" id="issue-pane">
				<div class="facets" id="facets"></div>
				<div class="issues-pane">
					<div class="issues-toolbar">
						<input type="text" id="issue-search" placeholder="filter by message…">
						<span class="count" id="issue-count"></span>
					</div>
					<div class="issues-viewport" id="issues-viewport">
						<div class="issues-spacer" id="issues-spacer"></div>
					</div>
				</div>
			</div>
		</div>
	`;

	updateSessionChrome();
	updateLogPane();

	const search = document.getElementById("issue-search");
	search.addEventListener(
		"input",
		debounce(() => {
			state.currentIssues.filter.q = search.value;
			state.currentIssues = {
				...state.currentIssues,
				offset: 0,
				list: [],
				pendingPages: new Set(),
			};
			loadIssuesAround(0);
			loadFacets();
		}, 200)
	);

	const viewport = document.getElementById("issues-viewport");
	viewport.addEventListener("scroll", () => renderVisibleIssues());

	if (session.hasReport) {
		state.currentSession._loadedReport = true;
		await Promise.all([loadIssuesAround(0), loadFacets()]);
	}

	// Listen for per-session events so we pick up the moment the report lands.
	const es = new EventSource(`/api/sessions/${id}/stream`);
	es.addEventListener("message", (e) => {
		try {
			const ev = JSON.parse(e.data);
			onSessionEvent(ev);
		} catch {}
	});
	$view._sessionES = es;
}

function onSessionEvent(ev) {
	if (getRoute().name !== "session") {
		// User navigated away; the old listener is still live until the next renderRoute.
		return;
	}
	if (ev.type === "state") {
		state.currentSession = { ...state.currentSession, ...ev.session };
		updateSessionChrome();
	} else if (ev.type === "log") {
		state.currentSession.logTail = (state.currentSession.logTail || [])
			.concat(ev.line)
			.slice(-200);
		updateLogPane();
	} else if (ev.type === "paused") {
		state.currentSession.status = "paused";
		state.currentSession.pauses = state.currentSession.pauses || {};
		state.currentSession.pauses[ev.side] = ev.pause;
		updateSessionChrome();
	} else if (ev.type === "resumed") {
		if (state.currentSession.pauses) {
			delete state.currentSession.pauses[ev.side];
			if (
				!state.currentSession.pauses.direct &&
				!state.currentSession.pauses.scramjet
			) {
				state.currentSession.pauses = undefined;
				state.currentSession.status = "running";
			}
		}
		updateSessionChrome();
	} else if (ev.type === "completed") {
		// The session record will arrive via the next state event. Eagerly load
		// issues so the UI flips fast.
		setTimeout(async () => {
			const r = await fetch(`/api/sessions/${state.currentSession.id}`);
			if (r.ok) {
				const s = await r.json();
				state.currentSession = s;
				state.currentSession._loadedReport = true;
				updateSessionChrome();
				state.currentIssues = {
					offset: 0,
					total: 0,
					list: [],
					pendingPages: new Set(),
					filter: state.currentIssues.filter,
				};
				await Promise.all([loadIssuesAround(0), loadFacets()]);
			}
		}, 100);
	}
}

function updateSessionChrome() {
	const container = document.getElementById("session-chrome");
	if (!container) return;
	const s = state.currentSession;
	const metrics = s.hasReport
		? `
		<div class="summary-grid">
			<div class="metric"><div class="label">issues</div><div class="value">${s.issueCount ?? 0}</div></div>
			<div class="metric"><div class="label">status</div><div class="value">${s.status}</div></div>
			<div class="metric"><div class="label">mode</div><div class="value">${s.mode}</div></div>
			<div class="metric"><div class="label">started</div><div class="value" style="font-size:11px">${fmtDate(s.startedAt)}</div></div>
			<div class="metric"><div class="label">duration</div><div class="value" style="font-size:12px">${fmtDuration(s.startedAt, s.completedAt)}</div></div>
		</div>
	`
		: `
		<div class="summary-grid">
			<div class="metric"><div class="label">status</div><div class="value">${s.status}</div></div>
			<div class="metric"><div class="label">mode</div><div class="value">${s.mode}</div></div>
			<div class="metric"><div class="label">progress</div><div class="value" style="font-size:12px">${escapeHtml(s.progress || "…")}</div></div>
		</div>
	`;

	let banners = "";
	if (s.status === "paused" && s.pauses) {
		const bpLabel = s.breakpoint
			? `${s.breakpoint.api} ${s.breakpoint.op ?? "*"} #${s.breakpoint.matchIndex}`
			: "debugger statement";
		const sideBadge = (sd) =>
			s.pauses[sd]
				? `<span class="status-badge paused" style="margin-right:6px">${sd}</span>`
				: "";
		const bothHalted = s.pauses.direct && s.pauses.scramjet;
		const resumeButtons =
			(s.pauses.scramjet
				? `<button class="primary" data-resume-side="scramjet">Resume scramjet</button>`
				: "") +
			(s.pauses.direct
				? `<button class="primary" data-resume-side="direct">Resume direct</button>`
				: "") +
			(bothHalted
				? `<button class="primary" data-resume-side="both">Resume both</button>`
				: "");
		banners += `<div class="banner paused">
			⏸ ${sideBadge("direct")}${sideBadge("scramjet")}paused at ${escapeHtml(bpLabel)}
			<div class="spacer"></div>
			${resumeButtons}
		</div>`;
	}
	if (s.status === "errored") {
		banners += `<div class="banner error">
			✗ errored: ${escapeHtml(s.error ?? "unknown")}
		</div>`;
	}
	container.innerHTML = `
		<div class="card">
			<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
				<h2 style="margin:0">${escapeHtml(s.target)}</h2>
				<span class="status-badge ${s.status}">${s.status}</span>
				<div class="spacer"></div>
				${s.status === "running" || s.status === "paused" ? '<button id="cancel-btn" class="danger">cancel</button>' : ""}
				${s.tracePath && s.mode === "record" ? `<button id="replay-this-btn" class="primary">replay this trace →</button>` : ""}
			</div>
			${banners}
			${metrics}
		</div>
	`;
	container.querySelectorAll("[data-resume-side]").forEach((btn) => {
		btn.addEventListener("click", () => {
			const side = btn.dataset.resumeSide;
			fetch(`/api/sessions/${s.id}/resume`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ side }),
			});
		});
	});
	const cancelBtn = document.getElementById("cancel-btn");
	if (cancelBtn) {
		cancelBtn.addEventListener("click", () =>
			fetch(`/api/sessions/${s.id}/cancel`, { method: "POST" })
		);
	}
	const replayBtn = document.getElementById("replay-this-btn");
	if (replayBtn) {
		replayBtn.addEventListener("click", () =>
			startReplay({ tracePath: s.tracePath })
		);
	}

	const logCard = document.getElementById("log-card");
	if (logCard) {
		logCard.style.display =
			s.status === "running" || s.status === "pending" || s.status === "paused"
				? "block"
				: "none";
	}
}

function updateLogPane() {
	const pane = document.getElementById("log-pane");
	if (!pane) return;
	const lines = state.currentSession.logTail || [];
	pane.innerHTML = lines
		.map((l) => `<div class="line">${escapeHtml(l)}</div>`)
		.join("");
	pane.scrollTop = pane.scrollHeight;
}

// ---------- issue list (virtualized) ----------

async function loadFacets() {
	const s = state.currentSession;
	if (!s.hasReport) return;
	// The full report is tiny relative to the issue list (summary + per-issue
	// kind/api). We rely on it instead of shipping facets on every paged response.
	const r = await fetch(`/api/sessions/${s.id}/report`);
	if (!r.ok) return;
	const rep = await r.json();
	state.currentFacets = computeFacets(rep.issues);
	renderFacets();
}

function computeFacets(issues) {
	const byKind = {};
	const byApi = {};
	for (const i of issues) {
		byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
		if (i.api) byApi[i.api] = (byApi[i.api] ?? 0) + 1;
	}
	const apis = Object.entries(byApi)
		.map(([api, count]) => ({ api, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 100);
	return { total: issues.length, byKind, byApi: apis };
}

function renderFacets() {
	const el = document.getElementById("facets");
	if (!el) return;
	const f = state.currentFacets || { total: 0, byKind: {}, byApi: [] };
	const kinds = Object.entries(f.byKind).sort((a, b) => b[1] - a[1]);
	const { kind: activeKind, api: activeApi } = state.currentIssues.filter;
	el.innerHTML = `
		<h3>kind</h3>
		<div class="facet ${!activeKind ? "active" : ""}" data-kind="">
			<span>all</span><span class="count">${f.total}</span>
		</div>
		${kinds
			.map(
				([k, c]) => `
			<div class="facet ${k === activeKind ? "active" : ""}" data-kind="${escapeHtml(k)}">
				<span>${escapeHtml(k)}</span><span class="count">${c}</span>
			</div>
		`
			)
			.join("")}
		<h3>api</h3>
		<div class="facet ${!activeApi ? "active" : ""}" data-api="">
			<span>all</span><span class="count">${f.total}</span>
		</div>
		${f.byApi
			.map(
				(a) => `
			<div class="facet ${a.api === activeApi ? "active" : ""}" data-api="${escapeHtml(a.api)}" title="${escapeHtml(a.api)}">
				<span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(a.api)}</span>
				<span class="count">${a.count}</span>
			</div>
		`
			)
			.join("")}
	`;
	el.querySelectorAll("[data-kind]").forEach((node) => {
		node.addEventListener("click", () => {
			state.currentIssues.filter.kind = node.dataset.kind || null;
			state.currentIssues = {
				...state.currentIssues,
				offset: 0,
				total: 0,
				list: [],
				pendingPages: new Set(),
			};
			renderFacets();
			loadIssuesAround(0);
		});
	});
	el.querySelectorAll("[data-api]").forEach((node) => {
		node.addEventListener("click", () => {
			state.currentIssues.filter.api = node.dataset.api || null;
			state.currentIssues = {
				...state.currentIssues,
				offset: 0,
				total: 0,
				list: [],
				pendingPages: new Set(),
			};
			renderFacets();
			loadIssuesAround(0);
		});
	});
}

async function loadIssuesAround(index) {
	const s = state.currentSession;
	if (!s?.hasReport) return;
	const page = Math.floor(index / PAGE_SIZE);
	const key = `p${page}`;
	if (state.currentIssues.pendingPages.has(key)) return;
	if (state.currentIssues.list[page * PAGE_SIZE] !== undefined) return;
	state.currentIssues.pendingPages.add(key);
	const { kind, api, q } = state.currentIssues.filter;
	const params = new URLSearchParams();
	params.set("offset", String(page * PAGE_SIZE));
	params.set("limit", String(PAGE_SIZE));
	if (kind) params.set("kind", kind);
	if (api) params.set("api", api);
	if (q) params.set("q", q);
	const r = await fetch(`/api/sessions/${s.id}/issues?${params}`);
	if (!r.ok) {
		state.currentIssues.pendingPages.delete(key);
		return;
	}
	const { total, issues } = await r.json();
	state.currentIssues.total = total;
	for (let i = 0; i < issues.length; i++) {
		state.currentIssues.list[page * PAGE_SIZE + i] = issues[i];
	}
	state.currentIssues.pendingPages.delete(key);
	renderVisibleIssues();
	updateIssueCount();
}

function updateIssueCount() {
	const n = document.getElementById("issue-count");
	if (!n) return;
	n.textContent = `${state.currentIssues.total.toLocaleString()} issues`;
}

function renderVisibleIssues() {
	const viewport = document.getElementById("issues-viewport");
	const spacer = document.getElementById("issues-spacer");
	if (!viewport || !spacer) return;
	const total = state.currentIssues.total;
	spacer.style.height = `${total * ROW_HEIGHT}px`;

	// Determine visible range.
	const viewTop = viewport.scrollTop;
	const viewBottom = viewTop + viewport.clientHeight;
	const startIdx = Math.max(0, Math.floor(viewTop / ROW_HEIGHT) - 10);
	const endIdx = Math.min(total, Math.ceil(viewBottom / ROW_HEIGHT) + 10);

	// Ensure data is loaded around this range.
	loadIssuesAround(startIdx);
	loadIssuesAround(endIdx - 1);

	// Reuse a pool of DOM rows.
	const rowsNeeded = endIdx - startIdx;
	const existing = spacer.querySelectorAll(".issue-row");
	for (let i = existing.length; i > rowsNeeded; i--) {
		existing[i - 1].remove();
	}
	for (let i = existing.length; i < rowsNeeded; i++) {
		const div = document.createElement("div");
		div.className = "issue-row";
		div.innerHTML = `<span class="kind"></span><span class="api"></span><span class="msg"></span>`;
		div.addEventListener("click", () => {
			const idx = Number(div.dataset.idx);
			const issue = state.currentIssues.list[idx];
			if (issue) openIssueDetail(issue, idx);
		});
		spacer.appendChild(div);
	}
	const rowEls = spacer.querySelectorAll(".issue-row");
	for (let i = 0; i < rowsNeeded; i++) {
		const idx = startIdx + i;
		const row = rowEls[i];
		row.dataset.idx = idx;
		row.style.top = `${idx * ROW_HEIGHT}px`;
		const issue = state.currentIssues.list[idx];
		if (issue) {
			row.dataset.kind = issue.kind;
			row.querySelector(".kind").textContent = issue.kind.replace(/-/g, " ");
			row.querySelector(".api").textContent = issue.api ?? "";
			row.querySelector(".msg").textContent = issue.message;
			row.style.visibility = "visible";
		} else {
			row.style.visibility = "hidden";
		}
	}
}

// ---------- issue detail drawer ----------

function openIssueDetail(issue, index) {
	closeDetailDrawer();
	const drawer = document.createElement("div");
	drawer.className = "detail-drawer";
	drawer.innerHTML = `
		<button class="close-btn" id="drawer-close">✕</button>
		<h2>${escapeHtml(issue.kind)} · ${escapeHtml(issue.api ?? "")}</h2>
		<div style="color:var(--fg-dim);font-family:var(--mono);font-size:11px;margin-bottom:10px">
			#${index} of ${state.currentIssues.total}
		</div>
		<pre style="white-space:pre-wrap">${escapeHtml(issue.message)}</pre>

		${
			issue.direct
				? `
		<div class="section">
			<h3>direct call</h3>
			<pre>${escapeHtml(JSON.stringify(summarizeEvent(issue.direct), null, 2))}</pre>
		</div>`
				: ""
		}

		${
			issue.scramjet
				? `
		<div class="section">
			<h3>scramjet call</h3>
			<pre>${escapeHtml(JSON.stringify(summarizeEvent(issue.scramjet), null, 2))}</pre>
		</div>`
				: ""
		}

		${
			issue.attribution?.suspects?.length
				? `
		<div class="section">
			<h3>suspects</h3>
			<pre>${escapeHtml(JSON.stringify(issue.attribution.suspects, null, 2))}</pre>
		</div>`
				: ""
		}

		${
			issue.api && (issue.scramjet || issue.direct)
				? `
		<div class="section">
			<h3>breakpoint</h3>
			<p style="color:var(--fg-dim);font-size:11px;line-height:1.4">
				Replay with a debugger stop at the Nth site-originated call to this API.
				The index counts only calls the page makes (scramjet's own traffic is excluded),
				so it's stable across replays.
			</p>
			<button class="primary" id="set-bp-btn">Set breakpoint on this API…</button>
		</div>`
				: ""
		}
	`;
	document.body.appendChild(drawer);
	state.currentIssueDetail = drawer;
	document
		.getElementById("drawer-close")
		.addEventListener("click", closeDetailDrawer);
	const bpBtn = document.getElementById("set-bp-btn");
	if (bpBtn) {
		bpBtn.addEventListener("click", () => {
			const pre = computeBreakpointHint(issue);
			openBreakpointModal(pre);
		});
	}
}

function computeBreakpointHint(issue) {
	const api = issue.api;
	if (!api) return { api: "", op: "", matchIndex: 1 };
	const ev = issue.scramjet || issue.direct;
	// For a rough first guess: use the position in the issue list as the matchIndex
	// among issues *of this same api* (not site-calls, but that's the best
	// heuristic available from the issue alone). Offer the right op based on event.op.
	let matchIndex = 1;
	for (const i of state.currentIssues.list) {
		if (!i) continue;
		if (i === issue) break;
		if (i.api === api && (i.scramjet?.op ?? i.direct?.op) === ev?.op)
			matchIndex++;
	}
	return { api, op: ev?.op ?? "", matchIndex };
}

function summarizeEvent(ev) {
	return {
		runSeq: ev.runSeq,
		taskId: ev.taskId,
		api: ev.api,
		op: ev.op,
		args: ev.args,
		post: ev.post,
		pre: ev.pre,
		self: ev.self,
		at: ev.scriptUrl ? `${ev.scriptUrl}:${ev.line}:${ev.column}` : undefined,
	};
}

function closeDetailDrawer() {
	if (state.currentIssueDetail) {
		state.currentIssueDetail.remove();
		state.currentIssueDetail = null;
	}
}

// ---------- modals ----------

function openModal(html, onMount) {
	$modal.innerHTML = `
		<div class="modal-backdrop">
			<div class="modal">${html}</div>
		</div>
	`;
	const backdrop = $modal.querySelector(".modal-backdrop");
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) closeModal();
	});
	onMount?.($modal.querySelector(".modal"));
}

function closeModal() {
	$modal.innerHTML = "";
}

function openNewRecordModal() {
	openModal(
		`
		<h2>Record new trace</h2>
		<div class="field">
			<label>Target URL</label>
			<input type="url" id="rec-url" placeholder="https://example.com" autofocus>
		</div>
		<div class="field">
			<label><input type="checkbox" id="rec-headed"> Run with visible browser window</label>
		</div>
		<div class="actions">
			<button id="rec-cancel">Cancel</button>
			<button id="rec-start" class="primary">Record →</button>
		</div>
	`,
		(root) => {
			root.querySelector("#rec-cancel").addEventListener("click", closeModal);
			root.querySelector("#rec-start").addEventListener("click", async () => {
				const target = root.querySelector("#rec-url").value.trim();
				const headless = !root.querySelector("#rec-headed").checked;
				if (!target) return;
				const r = await fetch("/api/sessions/record", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ target, headless }),
				});
				if (r.ok) {
					const s = await r.json();
					closeModal();
					location.hash = `#/session/${s.id}`;
				}
			});
		}
	);
}

function openNewDiffModal() {
	openModal(
		`
		<h2>New live diff</h2>
		<p style="color:var(--fg-dim);font-size:11px">Runs direct + scramjet against the URL and diffs. Non-deterministic APIs will show as false positives — use record/replay for signal-only.</p>
		<div class="field">
			<label>Target URL</label>
			<input type="url" id="d-url" placeholder="https://example.com" autofocus>
		</div>
		<div class="field">
			<label><input type="checkbox" id="d-headed"> Run with visible browser window</label>
		</div>
		<div class="actions">
			<button id="d-cancel">Cancel</button>
			<button id="d-start" class="primary">Run diff →</button>
		</div>
	`,
		(root) => {
			root.querySelector("#d-cancel").addEventListener("click", closeModal);
			root.querySelector("#d-start").addEventListener("click", async () => {
				const target = root.querySelector("#d-url").value.trim();
				const headless = !root.querySelector("#d-headed").checked;
				if (!target) return;
				const r = await fetch("/api/sessions/diff", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ target, headless }),
				});
				if (r.ok) {
					const s = await r.json();
					closeModal();
					location.hash = `#/session/${s.id}`;
				}
			});
		}
	);
}

function openReplaySelectModal() {
	openModal(
		`
		<h2>Replay existing trace</h2>
		<div class="field">
			<label>Trace file</label>
			<select id="rpl-select" style="min-width:420px">
				${state.traces.map((t) => `<option value="${escapeHtml(t.path)}">${escapeHtml(t.name)} · ${escapeHtml(t.target ?? "?")}</option>`).join("")}
			</select>
		</div>
		<div class="field">
			<label><input type="checkbox" id="rpl-headed"> Run with visible browser window</label>
		</div>
		<div class="actions">
			<button id="rpl-cancel">Cancel</button>
			<button id="rpl-start" class="primary">Replay →</button>
		</div>
	`,
		(root) => {
			root.querySelector("#rpl-cancel").addEventListener("click", closeModal);
			root.querySelector("#rpl-start").addEventListener("click", async () => {
				const tracePath = root.querySelector("#rpl-select").value;
				const headless = !root.querySelector("#rpl-headed").checked;
				if (!tracePath) return;
				const r = await fetch("/api/sessions/replay", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ tracePath, headless }),
				});
				if (r.ok) {
					const s = await r.json();
					closeModal();
					location.hash = `#/session/${s.id}`;
				}
			});
		}
	);
}

function openBreakpointModal(pre) {
	openModal(
		`
		<h2>Replay with breakpoint</h2>
		<p style="color:var(--fg-dim);font-size:11px;margin-bottom:12px">
			Replays the current session's trace in a new session, pausing when the probe sees the N-th site-originated (API, op) call matching the filter below. When paused, use Chrome DevTools on the harness window to inspect the call stack — or click Resume to continue.
		</p>
		<div class="field">
			<label>API path</label>
			<input type="text" id="bp-api" value="${escapeHtml(pre.api || "")}">
		</div>
		<div class="field">
			<label>Op</label>
			<select id="bp-op">
				<option value="">(any)</option>
				<option value="call" ${pre.op === "call" ? "selected" : ""}>call</option>
				<option value="construct" ${pre.op === "construct" ? "selected" : ""}>construct</option>
				<option value="get" ${pre.op === "get" ? "selected" : ""}>get</option>
				<option value="set" ${pre.op === "set" ? "selected" : ""}>set</option>
			</select>
		</div>
		<div class="field">
			<label>Match index (1-based)</label>
			<input type="number" id="bp-idx" min="1" value="${pre.matchIndex || 1}">
		</div>
		<div class="field">
			<label><input type="checkbox" id="bp-also-direct"> Also launch a non-scramjet window that pauses at the same breakpoint</label>
			<div style="font-size:10px;color:var(--fg-dim);line-height:1.4;margin-top:4px;padding-left:20px">
				Runs a live direct Chromium in parallel with the scramjet replay, halting both at the N-th site call.
				Useful for comparing scramjet vs native state at the halt point. The two runs go in parallel so both can be
				inspected concurrently, which means direct hits the real origin — expect network-flaky pages to diverge
				from the recorded baseline.
			</div>
		</div>
		<div class="field">
			<label><input type="checkbox" id="bp-headed" checked> Run with visible browser window (recommended to use DevTools at breakpoint)</label>
		</div>
		<div class="actions">
			<button id="bp-cancel">Cancel</button>
			<button id="bp-start" class="primary">Replay with breakpoint →</button>
		</div>
	`,
		(root) => {
			root.querySelector("#bp-cancel").addEventListener("click", closeModal);
			root.querySelector("#bp-start").addEventListener("click", async () => {
				const api = root.querySelector("#bp-api").value.trim();
				const opVal = root.querySelector("#bp-op").value;
				const matchIndex = Number(root.querySelector("#bp-idx").value);
				const headless = !root.querySelector("#bp-headed").checked;
				const alsoDirect = root.querySelector("#bp-also-direct").checked;
				if (!api || !matchIndex) return;
				const sessionSrc = state.currentSession;
				const tracePath =
					sessionSrc.mode === "replay"
						? sessionSrc.tracePath
						: sessionSrc.tracePath;
				if (!tracePath) {
					alert("This session has no associated trace — record first.");
					return;
				}
				const breakpoint = {
					api,
					op: opVal || undefined,
					matchIndex,
					alsoDirect,
				};
				const r = await fetch("/api/sessions/replay", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ tracePath, headless, breakpoint }),
				});
				if (r.ok) {
					const s = await r.json();
					closeModal();
					location.hash = `#/session/${s.id}`;
				}
			});
		}
	);
}

async function startReplay({ tracePath, breakpoint }) {
	const r = await fetch("/api/sessions/replay", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ tracePath, breakpoint }),
	});
	if (r.ok) {
		const s = await r.json();
		location.hash = `#/session/${s.id}`;
	}
}

// ---------- data fetchers ----------

async function refreshTraces() {
	const r = await fetch("/api/traces");
	if (r.ok) state.traces = await r.json();
}

async function refreshSessions() {
	const r = await fetch("/api/sessions");
	if (r.ok) {
		const list = await r.json();
		state.sessions.clear();
		for (const s of list) state.sessions.set(s.id, s);
	}
}

// ---------- utilities ----------

function escapeHtml(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[c]
	);
}

function fmtDate(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	return d.toLocaleString();
}

function fmtDuration(start, end) {
	if (!start) return "";
	const a = new Date(start).getTime();
	const b = end ? new Date(end).getTime() : Date.now();
	const ms = b - a;
	if (ms < 1000) return ms + "ms";
	if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
	const min = Math.floor(ms / 60_000);
	const sec = Math.floor((ms % 60_000) / 1000);
	return `${min}m${sec}s`;
}

function debounce(fn, delay) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), delay);
	};
}

// ---------- boot ----------

connectGlobalStream();
renderRoute();
