# scramdiff

A differential oracle for scramjet. Runs the same target URL twice — once
directly, once through scramjet — and reports every API call whose observable
result diverges. Divergences are the bugs; everything else is noise.

## Design

**Literal, not normalized.** The diff compares the value JS actually observed.
If scramjet's `document.URL` returns a proxy URL to the page, the page sees a
proxy URL, and that IS the bug — un-rewriting the value before comparing would
hide the exact class of leak scramjet exists to prevent. `pre` values
(what the underlying native API returned before scramjet intercepted) are
captured only as attribution for bug reports; they never influence equality.

**Wrap everything, not a curated list.** The in-page probe enumerates every
reachable Web IDL member by walking the prototype chain of every constructor
and every known instance on the global, then wraps all of them. Hardcoding a
list means the APIs scramjet forgot to intercept — which are precisely the
bugs we're hunting — stay invisible to the oracle.

**Installed after scramjet.** The probe defers its wrapping until it sees
`Symbol.for("scramjet client global")` on the global, ensuring our outer
wrapper sits strictly outside scramjet's interceptors. JS call →
scramdiff wrapper (records `post`) → scramjet wrapper (rewrites) → native.
We separately reach into `window[SCRAMJETCLIENT].natives.store` /
`descriptors.store` to invoke the native directly and capture `pre`.

**Determinism via Chromium testing primitives:**

- V8 `--predictable --random-seed=<seed>` for reproducible Math.random and
  internal V8 randomness.
- `Emulation.setVirtualTimePolicy` with `pauseIfNetworkFetchesPending` so
  `Date.now` / `performance.now` / `setTimeout` are tied to task sequence,
  not wall clock.
- SwiftShader for WebGL/canvas determinism.
- Fixed timezone (UTC) and locale (en-US).

Uncontrolled nondeterminism (GPU, audio fingerprinting, crypto.randomUUID in
edge paths, SharedArrayBuffer races) still leaks and is a known limitation —
bugs for a later forked-Chromium phase.

## Diff layers

1. **Event-level.** Per-origin, grouped into tasks by a causal `taskId`, events
   compared by `(api, op, args, self)`. Mismatches:
   - `value-divergence` — same call, different `post`.
   - `missing-interceptor` — same call, different `post`, AND scramjet's `pre`
     equals its `post` (scramjet returned the native value unchanged when it
     should have rewritten).
   - `missing-call` / `extra-call` — one run called something the other didn't.
2. **Coverage-level.** V8 precise coverage: per-function execution counts
   that differ between runs mean the site took a different branch. This is
   the strongest user-visible failure signal.
3. **Error-level.** pageerrors in one run but not the other.

## Usage

Scramdiff is self-contained. On startup it spins up its own scramjet harness
(HTTP + wisp servers on random loopback ports) and tears it down at exit — no
external harness URL, no manual encoder, no shared-port state to get out of
sync with whatever scramjet build is installed.

```sh
# Basic
pnpm diff https://example.com

# Watch the browser run
pnpm diff:headed https://example.com

# JSON report for tooling
pnpm diff https://example.com --json --out report.json
```

Exit code is `0` when no divergences are found, `1` when any issue surfaces,
`2` on fatal driver errors.

### Internal harness

The driver (`src/driver/harness-server.ts`) starts:

- An Express server on a random loopback port serving scramjet's `dist/`,
  scramjet-controller's `dist/`, libcurl-transport's `dist/`, plus a tiny
  `public/` directory with `index.html` (bootstrap) and `sw.js` (scramjet SW).
- A wisp server on a second random loopback port for LibcurlClient's transport.

The Playwright scramjet context opens the bootstrap page, waits for the SW to
activate and the Controller to be ready, then exposes
`window.__scramdiffEncode(url)` for the driver to call. To run a target, the
driver encodes the URL via the bootstrap page and opens a second page in the
same context — the SW scopes the whole origin, so the target page is
scramjet-proxied as a top-level document.

## Status

First-pass MVP. Known gaps documented in the source:

- Task IDs are a monotonic generation counter, not hooked scheduler lineage
  (comments in `probe.ts` flag where to upgrade).
- Network isn't recorded/replayed yet — both runs hit the real origin, which
  is fine for most sites but breaks on those with server-side A/B testing.
- Only window origins are fully plumbed; worker/service-worker origins are
  enumerated but the CDP binding isn't forwarded into worker isolates.
