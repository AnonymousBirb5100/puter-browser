import type { ScramjetClient } from "@mercuryworkshop/scramjet";

type EvtDesc = {
	originalcb: EventListenerOrEventListenerObject;
	/** `this` / EventTarget passed to `addEventListener` — not `event.target` */
	registerTarget: EventTarget;
	capture: boolean;
	injectafter?: (e: Event) => void;
};

type PhaseChains = { capture: EvtDesc[]; bubble: EvtDesc[] };

type ListenerMap = Map<EventTarget, Map<string, PhaseChains>>;

function phaseChains(
	listeners: ListenerMap,
	target: EventTarget,
	eventType: string
): PhaseChains {
	let byType = listeners.get(target);
	if (!byType) {
		byType = new Map();
		listeners.set(target, byType);
	}
	let chains = byType.get(eventType);
	if (!chains) {
		chains = { capture: [], bubble: [] };
		byType.set(eventType, chains);
	}
	return chains;
}

function chainForPhase(chains: PhaseChains, capture: boolean): EvtDesc[] {
	return capture ? chains.capture : chains.bubble;
}

function addEventListenerUseCapture(args: unknown[]): boolean {
	const opt = args[2];
	if (typeof opt === "boolean") return opt;
	if (typeof opt === "object" && opt !== null && "capture" in opt) {
		return Boolean((opt as AddEventListenerOptions).capture);
	}
	return false;
}

export type BubblePhaseLastScheduler = {
	trackEventType(eventType: string): void;
	scheduleRunAfterOtherBubbleListeners(e: Event, run: (e: Event) => void): void;
	/** For handlers registered in the capture phase; runs after all capture listeners on the path. */
	scheduleRunAfterOtherCaptureListeners(
		e: Event,
		run: (e: Event) => void
	): void;
};

const schedulers = new WeakMap<ScramjetClient, BubblePhaseLastScheduler>();

export function getBubblePhaseLastScheduler(
	client: ScramjetClient
): BubblePhaseLastScheduler {
	let s = schedulers.get(client);
	if (!s) {
		s = createBubblePhaseLastScheduler(client);
		schedulers.set(client, s);
	}
	return s;
}

function createBubblePhaseLastScheduler(
	client: ScramjetClient
): BubblePhaseLastScheduler {
	const trackedTypes = new Set<string>();
	let proxyInstalled = false;

	const eventListeners: ListenerMap = new Map();
	let currentlyExecutingDesc: EvtDesc | null = null;

	function attachPropagationGuards(e: Event, run: (e: Event) => void) {
		const eventType = e.type;
		client.RawProxy(e, "stopImmediatePropagation", {
			apply() {
				if (!currentlyExecutingDesc) {
					throw new Error("stopImmediatePropagation called but no desc found?");
				}
				currentlyExecutingDesc.injectafter = run;
			},
		});
		client.RawProxy(e, "stopPropagation", {
			apply() {
				if (!currentlyExecutingDesc) {
					throw new Error("stopPropagation called but no desc found?");
				}
				const chains = eventListeners
					.get(currentlyExecutingDesc.registerTarget)
					?.get(eventType);
				if (!chains) {
					throw new Error("no descs found in stopPropagation()");
				}
				const descs = chainForPhase(chains, currentlyExecutingDesc.capture);
				const idx = descs.indexOf(currentlyExecutingDesc);
				if (idx === -1) {
					throw new Error("couldn't find currentlyExecutingDesc");
				}
				const remaining = descs.slice(idx + 1);
				if (remaining.length > 0) {
					const last = remaining[remaining.length - 1];
					last.injectafter = run;
				} else {
					// Propagation cut with no later same-target listeners; deeper
					// nodes never run, so injectafter on their chain would never fire.
					currentlyExecutingDesc.injectafter = run;
				}
			},
		});
	}

	function installProxy() {
		if (proxyInstalled) return;
		proxyInstalled = true;

		client.Proxy("EventTarget.prototype.addEventListener", {
			apply(ctx) {
				const eventType = ctx.args[0];
				if (typeof eventType !== "string" || !trackedTypes.has(eventType)) {
					return;
				}

				const useCapture = addEventListenerUseCapture(ctx.args as unknown[]);
				const cb = ctx.args[1] as EventListenerOrEventListenerObject;
				const chain = chainForPhase(
					phaseChains(eventListeners, ctx.this, eventType),
					useCapture
				);

				ctx.args[1] = function (this: unknown, ...args: unknown[]) {
					const desc = chain.find((d) => d.originalcb === cb)!;

					currentlyExecutingDesc = desc;
					if (typeof cb === "function") {
						Reflect.apply(cb, this, args);
					} else if (
						typeof cb === "object" &&
						cb !== null &&
						"handleEvent" in cb &&
						typeof cb.handleEvent === "function"
					) {
						Reflect.apply(cb.handleEvent, cb, args);
					}

					if (desc.injectafter) {
						desc.injectafter(args[0] as Event);
						delete desc.injectafter;
					}
					currentlyExecutingDesc = null;
				};

				chain.push({
					originalcb: cb,
					registerTarget: ctx.this,
					capture: useCapture,
				});
			},
		});
	}

	return {
		trackEventType(eventType: string) {
			trackedTypes.add(eventType);
			installProxy();
		},

		scheduleRunAfterOtherBubbleListeners(e: Event, run: (e: Event) => void) {
			const eventType = e.type;
			let lastlistener: EvtDesc | undefined;

			for (const elm of e.composedPath()) {
				const byType = eventListeners.get(elm);
				if (!byType) continue;
				const chains = byType.get(eventType);
				const bubble = chains?.bubble;
				if (bubble?.length) {
					lastlistener = bubble[bubble.length - 1];
				}
			}

			if (!lastlistener) {
				run(e);
			} else {
				lastlistener.injectafter = run;
			}

			attachPropagationGuards(e, run);
		},

		scheduleRunAfterOtherCaptureListeners(e: Event, run: (e: Event) => void) {
			const eventType = e.type;
			const path = e.composedPath();
			let lastlistener: EvtDesc | undefined;

			for (let i = path.length - 1; i >= 0; i--) {
				const byType = eventListeners.get(path[i]!);
				if (!byType) continue;
				const chains = byType.get(eventType);
				const capture = chains?.capture;
				if (capture?.length) {
					lastlistener = capture[capture.length - 1];
				}
			}

			if (!lastlistener) {
				run(e);
			} else {
				lastlistener.injectafter = run;
			}

			attachPropagationGuards(e, run);
		},
	};
}
