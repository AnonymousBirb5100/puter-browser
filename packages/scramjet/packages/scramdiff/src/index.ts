/**
 * Library entrypoint.
 *
 * Usage from Node:
 *
 *   import { withDriver, diffRuns, formatReport } from "scramdiff";
 *
 *   await withDriver({ scramjetEncode }, async (run) => {
 *     const { direct, scramjet } = await run("https://example.com");
 *     const report = diffRuns("https://example.com", direct, scramjet);
 *     console.log(formatReport(report));
 *   });
 */

export {
	withDriver,
	type DriverOptions,
	type DriverRun,
} from "./driver/index.ts";
export { diffRuns } from "./diff/diff.ts";
export { formatReport } from "./diff/report.ts";
export type {
	DiffIssue,
	DiffIssueKind,
	DiffReport,
	Harness,
	RunArtifacts,
	TraceEvent,
	TraceOp,
	TraceOrigin,
	TraceValue,
	CoverageSample,
} from "./trace.ts";
