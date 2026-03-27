import { ExecutionContextWrapper } from "../context";
import { getBubblePhaseLastScheduler } from "./alwaysLastBubble";

export function setupAnchorHandler({
	self,
	rpc,
	client,
}: ExecutionContextWrapper) {
	const bubbleLast = getBubblePhaseLastScheduler(client);
	bubbleLast.trackEventType("click");
	// goal is to override the default behavior of clicking on an <a> link
	// if the link is target=_blank it needs to open in a new browser.js tab instead of a native tab
	// the browser does not provide a neat way of knowing when a link is clicked through
	//
	// so the only solution left is to addEventListener("click") on every single <a> element
	// however, this presents an issue
	// if the page has its *own* event listener, and it calls e.preventDefault(), we need to not open the tab, since we're essentially acting as the new default
	// since events bubble down and can have non trivial control flows, this gets complicated fast
	//
	// the only solution is to register both the first and last event listeners, so that you control the entire call stack
	// registering the first is easy, you just need to call it immediately after creation
	// registering the *last* is extremely difficult

	const anchorObserver = new MutationObserver((mutations) => {
		mutations.forEach((mutation) => {
			setTimeout(() => {
				mutation.addedNodes.forEach((_node) => {
					let node: HTMLAnchorElement = _node as any;
					if ("tagName" in node && node.tagName == "A") {
						const openInNewTab = () => {
							// note that this is the intercepted version
							const href = node.href;

							rpc.call("newtab", {
								url: href,
							});
						};

						const iAmLastListener = (e: MouseEvent) => {
							if (node.target != "_blank") return;
							if (e.defaultPrevented) return; // our behavior is what the new "default" is, so we don't want to trigger
							e.preventDefault();
							e.stopImmediatePropagation(); // for good measure
							openInNewTab();
						};

						// this event will always run before all other ones, since it was registered at injectHistoryEmulation
						// * unless you registered the event before appending to the dom
						// * unless there's something inside of the <a> that has a listener on it
						// * unless there's a capture listener
						// TODO fix those cases

						client.natives.call(
							"EventTarget.prototype.addEventListener",
							node,
							"click",
							(e: MouseEvent) => {
								bubbleLast.scheduleRunAfterOtherBubbleListeners(e, (ev) => {
									iAmLastListener(ev as MouseEvent);
								});
							}
						);
						// TODO: jankify this too
						client.natives.call(
							"EventTarget.prototype.addEventListener",
							node,
							"auxclick",
							(e: MouseEvent) => {
								if (e.button !== 1) return; // middle click
								e.preventDefault();
								openInNewTab();
							}
						);
					}
				});
			}, 2000);
		});
	});
	anchorObserver.observe(self.document, {
		childList: true,
		subtree: true,
	});

	self.addEventListener("load", () => {
		self.document.querySelectorAll("*").forEach((e) => e);
	});
}
