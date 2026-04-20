/**
 * Shared trace types between the in-page probe and the differ.
 *
 * The probe emits TraceEvents over a CDP binding. The driver collects them,
 * groups them into tasks, and hands them to the differ.
 *
 * Design notes:
 *
 *   - Every DOM API call scramjet might intercept produces one TraceEvent.
 *   - In the scramjet run, `post` is what JS actually observed (post-rewrite)
 *     and `pre` is what the underlying native API returned (pre-rewrite).
 *     In the direct run, pre === post.
 *   - `taskId` is a causal ID derived from the scheduling chain of the task
 *     this event executed inside. Two runs that scheduled work from the same
 *     call sites at the same virtual time produce identical taskIds.
 *   - `seq` is the monotonic index of this event within its task.
 *   - `origin` tags which global emitted the event (window, worker, iframe)
 *     so cross-context traces can be aligned separately.
 */

export type Harness = "direct" | "scramjet";

export type TraceOrigin = {
	kind: "window" | "worker" | "sharedworker" | "serviceworker";
	/** Stable identifier for this global; for windows this is their frame tree path. */
	id: string;
	/** The URL of the document/worker, after scramjet unrewriting. */
	url: string;
};

export type TraceOp =
	| "call" // function/method invocation (apply)
	| "construct" // `new Foo(...)`
	| "get" // property read
	| "set"; // property write

export type TraceValue =
	| { t: "primitive"; v: string | number | boolean | null }
	| { t: "undefined" }
	| { t: "bigint"; v: string }
	| { t: "symbol"; v: string }
	| { t: "string"; v: string }
	| { t: "object"; ctor: string; summary: string; hash: string }
	| { t: "array"; length: number; summary: string; hash: string }
	| { t: "function"; name: string; length: number }
	| { t: "dom"; ctor: string; desc: string }
	| { t: "error"; name: string; message: string }
	| { t: "unserializable"; reason: string };

export type TraceEvent = {
	/** Monotonic sequence across the whole run. */
	runSeq: number;
	/** Sequence within this task. */
	taskSeq: number;
	/** Causal task ID — equal across runs when scheduling lineage matches. */
	taskId: string;
	/** API path, e.g. "Document.prototype.cookie". Matches scramjet's naming. */
	api: string;
	op: TraceOp;
	/** Serialized arguments (for call/construct) or the set value (for set). */
	args?: TraceValue[];
	/** Post-interceptor return value — what JS observed. */
	post: TraceValue;
	/**
	 * Pre-interceptor native value — in scramjet runs, this is what the
	 * underlying browser would have returned before scramjet rewrote it.
	 * Recorded to help attribute divergences: if post differs between runs
	 * but pre is identical, scramjet's rewrite is the bug.
	 */
	pre?: TraceValue;
	/** `this` receiver summary, for methods where it matters (e.g., document vs. a random element). */
	self?: TraceValue;
	/** Top script URL of the call site, for attribution. */
	scriptUrl?: string;
	/** Line/column of the caller. */
	line?: number;
	column?: number;
	/** Virtual time at which this event fired. */
	vtime: number;
	/** Whether this event was emitted from scramjet-internal code (filtered before diff). */
	internal: boolean;
	origin: TraceOrigin;
};

export type CoverageSample = {
	/** Script URL (unrewritten). */
	url: string;
	/** V8 precise coverage function entries. */
	functions: Array<{
		functionName: string;
		ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
		isBlockCoverage: boolean;
	}>;
};

export type RunArtifacts = {
	harness: Harness;
	/** Start-time and end-time in virtual ms. */
	vtimeStart: number;
	vtimeEnd: number;
	/** Origin-keyed trace streams. */
	traces: Record<string, TraceEvent[]>;
	/** Coverage per script URL (canonicalized). */
	coverage: CoverageSample[];
	/** Console messages, kept for attribution narrative. */
	console: Array<{ level: string; text: string; vtime: number }>;
	/** Page errors, likely the user-visible symptom. */
	errors: Array<{ message: string; stack?: string; vtime: number }>;
	/** Final document URL (canonicalized). */
	finalUrl: string;
	/** Probe install timing — debugging aid. */
	probeInstalledAt: number | null;
	/**
	 * Nondeterminism captures, keyed by fully-qualified API path
	 * ("Math.random", "Crypto.prototype.getRandomValues", etc.).
	 * Only populated on runs where the probe ran in "record" ndMode;
	 * otherwise absent.
	 *
	 * Each entry's shape is specific to its API — numbers for clocks/rng,
	 * hex-encoded bytes for getRandomValues, strings for randomUUID. The
	 * replay harness consumes these in FIFO order per api path.
	 */
	ndCaptures?: Record<string, NDCapture[]>;
};

/**
 * One recorded nondeterministic value. `data` is opaque to the driver; the
 * probe's ND source spec understands how to serialize on record and
 * deserialize on replay.
 */
export type NDCapture = {
	/** API path that produced this value. */
	api: string;
	/** Captured payload. For "Math.random": { v: number }. For
	 *  "Crypto.prototype.getRandomValues": { hex: string }. Etc. */
	data: any;
};

/**
 * On-disk format for a recorded direct run. Loaded by `scramdiff replay`.
 * The `direct` RunArtifacts includes ndCaptures; the replay harness seeds
 * those into the scramjet probe and diffs the resulting scramjet run
 * against direct.
 */
export type RecordedTrace = {
	version: 1;
	target: string;
	/** ISO timestamp of when the record completed. */
	recordedAt: string;
	/** RunArtifacts from the direct run, with ndCaptures populated. */
	direct: RunArtifacts;
};

export type DiffIssueKind =
	| "value-divergence" // post differs; pre was identical → interceptor bug
	| "native-divergence" // pre differs → not a scramjet bug, nondeterminism leak
	| "missing-interceptor" // scramjet returned native value unchanged but it should have been rewritten (heuristic)
	| "missing-call" // direct run made a call scramjet's run did not
	| "extra-call" // scramjet run made a call direct did not (often an injected shim)
	| "coverage-divergence" // branch divergence in user script
	| "error-divergence"; // one run threw, the other did not

export type DiffIssue = {
	kind: DiffIssueKind;
	api?: string;
	message: string;
	direct?: TraceEvent;
	scramjet?: TraceEvent;
	attribution?: {
		coveragePoint?: { url: string; functionName: string; offset: number };
		/** Recent API calls whose return value differed; most recent first. */
		suspects: Array<{
			api: string;
			directPost: TraceValue;
			scramjetPost: TraceValue;
		}>;
	};
};

export type DiffReport = {
	target: string;
	issues: DiffIssue[];
	summary: {
		eventsDirect: number;
		eventsScramjet: number;
		tasksMatched: number;
		tasksUnmatched: number;
		coverageDivergentScripts: number;
	};
};
