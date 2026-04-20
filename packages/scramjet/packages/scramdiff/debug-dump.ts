/**
 * Debug: dump raw artifacts from both harnesses so we can see what's actually
 * being captured. Not part of the shipping CLI.
 */
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startHarnessServer } from "./src/driver/harness-server.ts";
import { withDriver } from "./src/driver/index.ts";

const target = process.argv[2] || "https://example.com";

// Also: directly reproduce what the user sees in headed mode — load the proxy
// URL in a plain chromium page, screenshot both direct and proxied.
if (process.env.SCREENSHOT === "1") {
	const server = await startHarnessServer();
	const browser = await chromium.launch({ headless: true });
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	page.on("console", (m) =>
		console.log(`  [console ${m.type()}] ${m.text().slice(0, 200)}`)
	);
	page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

	await page.goto(server.rootUrl + "/__scramdiff_harness_bootstrap", {
		waitUntil: "load",
		timeout: 60_000,
	});
	await page.waitForFunction(
		() => (globalThis as any).__scramdiffHarnessReady === true,
		{ timeout: 60_000 }
	);
	const proxied = await page.evaluate(
		(u: string) => (globalThis as any).__scramdiffEncode(u),
		target
	);
	console.log("proxy url:", proxied);
	await page
		.goto(proxied, { waitUntil: "load", timeout: 60_000 })
		.catch((e) => console.log("goto:", e.message));
	await new Promise((r) => setTimeout(r, 3000));
	const html = await page.content();
	await writeFile("/tmp/scramjet-proxied.html", html);
	await page.screenshot({ path: "/tmp/scramjet-proxied.png", fullPage: true });
	console.log("scramjet page title:", await page.title());
	console.log(
		"scramjet page text (500 char):",
		(await page.evaluate(() => document.body?.innerText || "")).slice(0, 500)
	);

	const page2 = await ctx.newPage();
	await page2.goto(target, { waitUntil: "load", timeout: 60_000 });
	await page2.screenshot({ path: "/tmp/direct.png", fullPage: true });
	console.log("direct page title:", await page2.title());
	console.log(
		"direct page text (500 char):",
		(await page2.evaluate(() => document.body?.innerText || "")).slice(0, 500)
	);

	await browser.close();
	await server.close();
	process.exit(0);
}

await withDriver(
	{
		headless: process.env.HEADED !== "1",
		log: (l) => process.stderr.write("[dbg] " + l + "\n"),
	},
	async (run) => {
		const { direct, scramjet } = await run(target);

		for (const [label, a] of [
			["DIRECT", direct],
			["SCRAMJET", scramjet],
		] as const) {
			if (!a) continue;
			console.log(`\n=== ${label} ===`);
			console.log(`  finalUrl:         ${a.finalUrl}`);
			console.log(`  probeInstalledAt: ${a.probeInstalledAt}`);
			console.log(`  errors:           ${a.errors.length}`);
			for (const e of a.errors) console.log(`    ${e.message}`);
			console.log(`  console:          ${a.console.length}`);
			for (const c of a.console.slice(0, 5))
				console.log(`    [${c.level}] ${c.text.slice(0, 200)}`);
			console.log(`  traces origins:   ${Object.keys(a.traces).length}`);
			for (const oid of Object.keys(a.traces)) {
				const evs = a.traces[oid];
				console.log(`  origin ${oid}: ${evs.length} events`);
				for (const ev of evs) {
					const url = ev.scriptUrl
						? ` @ ${ev.scriptUrl}:${ev.line}:${ev.column}`
						: "";
					console.log(
						`    #${ev.runSeq} task=${ev.taskId} ${ev.api}.${ev.op} internal=${ev.internal} vtime=${ev.vtime.toFixed(1)}${url}`
					);
				}
			}
			console.log(`  coverage scripts: ${a.coverage.length}`);
			for (const cs of a.coverage.slice(0, 10)) {
				const total = cs.functions.reduce(
					(acc, f) => acc + f.ranges.reduce((a, r) => a + r.count, 0),
					0
				);
				console.log(
					`    ${cs.url}  fns=${cs.functions.length} totalCalls=${total}`
				);
			}
		}
	}
);
