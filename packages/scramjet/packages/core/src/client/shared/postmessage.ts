import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { POLLUTANT } from "./realm";

export default function (client: ScramjetClient, self: Self) {
	if (iswindow)
		client.Proxy("window.postMessage", {
			apply(ctx) {
				console.error("SHOULDN'T BE CALLABLE");
			},
		});

	const toproxy = ["MessagePort.prototype.postMessage"];

	if (self.Worker) toproxy.push("Worker.prototype.postMessage");
	if (!iswindow) toproxy.push("self.postMessage"); // only do the generic version if we're in a worker

	client.Proxy(toproxy, {
		apply(ctx) {
			// origin/source doesn't need to be preserved - it's null in the message event

			ctx.args[0] = {
				$scramjet$messagetype: "worker",
				$scramjet$data: ctx.args[0],
			};
		},
	});
	Object.defineProperty(self, client.config.globals.wrappostmessagefn, {
		value: function (obj: any) {
			if (!obj || typeof obj.postMessage !== "function") return obj;
			return {
				postMessage: new Proxy(obj.postMessage, {
					apply(target, thisarg, argarray) {
						// this WOULD be enough but the source argument of MessageEvent has to return the caller's window
						// and if we just call it normally it would be coming from here, which WILL NOT BE THE CALLER'S because the accessor is from the parent
						// so with the stolen function we wrap postmessage so the source will truly be the caller's window (remember that function is scramjet's!!!)
						argarray[0] = {
							$scramjet$messagetype: "window",
							$scramjet$origin: client.url.origin,
							$scramjet$data: argarray[0],
						};

						// * origin because obviously
						if (typeof argarray[1] === "string") argarray[1] = "*";
						if (typeof argarray[1] === "object") argarray[1].targetOrigin = "*";

						return Reflect.apply(obj.postMessage, obj, argarray);
					},
				}),
			};
		},
		configurable: false,
		writable: false,
		enumerable: false,
	});
}
