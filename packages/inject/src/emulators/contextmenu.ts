import { ExecutionContextWrapper } from "../context";
import { Chromebound } from "../types";
import { getBubblePhaseLastScheduler } from "./alwaysLastBubble";

export function setupContextMenu({
	self,
	rpc,
	client,
}: ExecutionContextWrapper) {
	const scheduler = getBubblePhaseLastScheduler(client);
	scheduler.trackEventType("contextmenu");

	// Capture phase + window: runs before document/body listeners. Bubble listeners
	// never run if a capture handler calls stopPropagation().
	client.natives.call(
		"EventTarget.prototype.addEventListener",
		self,
		"contextmenu",
		(e: Event) => {
			scheduler.scheduleRunAfterOtherCaptureListeners(e, (ev) => {
				if (ev.defaultPrevented) return;

				ev.preventDefault();
				const target = ev.target;
				const selection = getSelection()?.toString();

				const resp: Chromebound["contextmenu"][0] = {
					x: (ev as MouseEvent).clientX,
					y: (ev as MouseEvent).clientY,
					selection,
				};

				if (client.box.instanceof(target, "HTMLImageElement")) {
					const targetImage = target as HTMLImageElement;
					resp.image = {
						src: targetImage.src,
						width: targetImage.naturalWidth,
						height: targetImage.naturalHeight,
					};
				} else if (client.box.instanceof(target, "HTMLAnchorElement")) {
					const targetAnchor = target as HTMLAnchorElement;
					resp.anchor = {
						href: targetAnchor.href,
					};
				} else if (client.box.instanceof(target, "HTMLVideoElement")) {
					const targetVideo = target as HTMLVideoElement;
					resp.video = {
						src: targetVideo.currentSrc,
						width: targetVideo.videoWidth,
						height: targetVideo.videoHeight,
					};
				}

				rpc.call("contextmenu", resp);
			});
		},
		{ capture: true }
	);
}
