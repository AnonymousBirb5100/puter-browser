/**
 * Human-readable formatter for DiffReports.
 *
 * The CLI prints this to stdout; tooling can also consume the raw JSON form
 * via `--json`. Emits a short, triage-friendly view: the first N issues, with
 * suspect attribution and call-site info so a human can jump to the right line.
 */

import type { DiffIssue, DiffReport, TraceValue } from "../trace.ts";

function describe(v: TraceValue): string {
	switch (v.t) {
		case "undefined":
			return "undefined";
		case "primitive":
			return JSON.stringify((v as any).v);
		case "string": {
			const s = (v as any).v as string;
			return JSON.stringify(s.length > 120 ? s.slice(0, 120) + "…" : s);
		}
		case "bigint":
			return `${(v as any).v}n`;
		case "symbol":
			return `Symbol(${(v as any).v})`;
		case "function":
			return `function ${v.name || "(anon)"}/${v.length}`;
		case "object":
			return `${(v as any).ctor} ${(v as any).summary}`;
		case "array":
			return `Array(${(v as any).length}) ${(v as any).summary}`;
		case "dom":
			return `<${v.desc}>`;
		case "error":
			return `${v.name}: ${v.message}`;
		case "unserializable":
			return `«unserializable: ${v.reason}»`;
	}
}

function formatIssue(issue: DiffIssue, index: number): string {
	const parts: string[] = [];
	parts.push(
		`#${index + 1} [${issue.kind}]${issue.api ? ` ${issue.api}` : ""}`
	);
	parts.push(`  ${issue.message}`);
	if (issue.direct?.scriptUrl) {
		parts.push(
			`  at ${issue.direct.scriptUrl}:${issue.direct.line}:${issue.direct.column}`
		);
	} else if (issue.scramjet?.scriptUrl) {
		parts.push(
			`  at ${issue.scramjet.scriptUrl}:${issue.scramjet.line}:${issue.scramjet.column}`
		);
	}
	if (issue.direct && issue.scramjet) {
		parts.push(`    direct post: ${describe(issue.direct.post)}`);
		parts.push(`    scramjet post: ${describe(issue.scramjet.post)}`);
		if (issue.scramjet.pre) {
			parts.push(`    scramjet pre (native): ${describe(issue.scramjet.pre)}`);
		}
	}
	if (issue.attribution?.suspects && issue.attribution.suspects.length > 0) {
		parts.push(`  recent divergences leading here:`);
		for (const s of issue.attribution.suspects) {
			parts.push(
				`    - ${s.api}: direct=${describe(s.directPost)} scramjet=${describe(s.scramjetPost)}`
			);
		}
	}
	if (issue.attribution?.coveragePoint) {
		const c = issue.attribution.coveragePoint;
		parts.push(
			`  coverage fork at ${c.url}::${c.functionName} (offset ${c.offset})`
		);
	}
	return parts.join("\n");
}

export function formatReport(
	report: DiffReport,
	opts: { maxIssues?: number } = {}
): string {
	const max = opts.maxIssues ?? 50;
	const lines: string[] = [];

	lines.push(`scramdiff report for ${report.target}`);
	lines.push("─".repeat(60));
	lines.push(
		`  events: direct=${report.summary.eventsDirect} scramjet=${report.summary.eventsScramjet}`
	);
	lines.push(
		`  tasks:  matched=${report.summary.tasksMatched} unmatched=${report.summary.tasksUnmatched}`
	);
	lines.push(
		`  coverage-divergent scripts: ${report.summary.coverageDivergentScripts}`
	);
	lines.push("");
	if (report.issues.length === 0) {
		lines.push("✓ no divergences detected");
		return lines.join("\n");
	}

	// Group by kind for the summary line.
	const byKind = new Map<string, number>();
	for (const i of report.issues) {
		byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
	}
	lines.push(`${report.issues.length} issue(s):`);
	for (const [k, n] of byKind) lines.push(`  ${k}: ${n}`);
	lines.push("");

	// Rank: value-divergence (most actionable) first, then missing-interceptor,
	// then coverage, then missing/extra, then error.
	const order: Record<DiffIssue["kind"], number> = {
		"value-divergence": 0,
		"missing-interceptor": 1,
		"native-divergence": 2,
		"coverage-divergence": 3,
		"missing-call": 4,
		"extra-call": 5,
		"error-divergence": 6,
	};
	const sorted = [...report.issues].sort(
		(a, b) => order[a.kind] - order[b.kind]
	);

	for (let i = 0; i < Math.min(sorted.length, max); i++) {
		lines.push(formatIssue(sorted[i], i));
		lines.push("");
	}
	if (sorted.length > max) {
		lines.push(
			`… ${sorted.length - max} more issues truncated (use --json for full report)`
		);
	}
	return lines.join("\n");
}
