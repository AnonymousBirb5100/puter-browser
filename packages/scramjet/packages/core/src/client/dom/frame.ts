import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";

const FRAME_SELECTOR = "iframe,frame,object,embed";
const FRAME_TAGS = new Set(["iframe", "frame", "object", "embed"]);

type FrameHost =
	| HTMLIFrameElement
	| HTMLFrameElement
	| HTMLObjectElement
	| HTMLEmbedElement;

function isFrameHost(node: Node): node is FrameHost {
	return (
		node.nodeType === 1 &&
		FRAME_TAGS.has((node as Element).localName.toLowerCase())
	);
}

export function collectFrameHosts(
	client: ScramjetClient,
	node: unknown,
	out: FrameHost[] = []
): FrameHost[] {
	if (!node || typeof node !== "object") return out;

	const candidate = node as Node;
	if (candidate.nodeType === 1) {
		const element = candidate as Element;
		if (isFrameHost(element)) out.push(element);
		if (element.childElementCount === 0) return out;

		const frames = client.natives.call(
			"Element.prototype.querySelectorAll",
			element,
			FRAME_SELECTOR
		) as NodeListOf<FrameHost>;
		for (let i = 0; i < frames.length; i++) out.push(frames[i]);
		return out;
	}

	if (candidate.nodeType === 9) {
		const frames = client.natives.call(
			"Document.prototype.querySelectorAll",
			candidate,
			FRAME_SELECTOR
		) as NodeListOf<FrameHost>;
		for (let i = 0; i < frames.length; i++) out.push(frames[i]);
		return out;
	}

	if (candidate.nodeType === 11) {
		const fragment = candidate as DocumentFragment;
		if (fragment.childElementCount === 0) return out;

		const frames = client.natives.call(
			"DocumentFragment.prototype.querySelectorAll",
			fragment,
			FRAME_SELECTOR
		) as NodeListOf<FrameHost>;
		for (let i = 0; i < frames.length; i++) out.push(frames[i]);
	}

	return out;
}

export function hookFrameHost(client: ScramjetClient, frame: FrameHost) {
	let realwin: Window | null = null;

	try {
		realwin = client.descriptors.get(
			`${frame.constructor.name}.prototype.contentWindow`,
			frame
		) as Window | null;
	} catch {
		return;
	}

	if (!realwin) return;

	try {
		if (!(SCRAMJETCLIENT in realwin)) {
			client.init.hookSubcontext(
				realwin as unknown as Self,
				frame as HTMLIFrameElement
			);
		}
	} catch {
		// Cross-origin or plugin-backed contexts are not synchronously hookable.
	}
}

export function hookFrameHosts(client: ScramjetClient, frames: FrameHost[]) {
	for (let i = 0; i < frames.length; i++) {
		hookFrameHost(client, frames[i]);
	}
}

export function isFrameTreeLive(root: unknown) {
	if (!root || typeof root !== "object") return false;

	const node = root as Node & { host?: Node };
	if (node.nodeType === 9) return true;
	if (node.isConnected) return true;
	return !!node.host?.isConnected;
}

export function hookFrameTree(client: ScramjetClient, root: unknown) {
	if (!isFrameTreeLive(root)) return;
	hookFrameHosts(client, collectFrameHosts(client, root));
}

function collectFrameHostArgs(client: ScramjetClient, args: unknown[]) {
	const frames: FrameHost[] = [];
	for (let i = 0; i < args.length; i++) {
		if (typeof args[i] === "string") continue;
		collectFrameHosts(client, args[i], frames);
	}
	return frames;
}

function proxyNodeInsertion(
	client: ScramjetClient,
	method: string,
	getInsertedArgs: (args: unknown[]) => unknown[]
) {
	client.Proxy(method as any, {
		apply(ctx) {
			const frames = isFrameTreeLive(ctx.this)
				? collectFrameHostArgs(client, getInsertedArgs(ctx.args))
				: [];
			const ret = ctx.call();
			hookFrameHosts(client, frames);
			ctx.return(ret);
		},
	});
}

function proxyHtmlSink(client: ScramjetClient, method: string) {
	client.Proxy(method as any, {
		apply(ctx) {
			const ret = ctx.call();
			hookFrameTree(client, ctx.this);
			ctx.return(ret);
		},
	});
}

function proxyRangeInsertion(client: ScramjetClient, method: string) {
	client.Proxy(method as any, {
		apply(ctx) {
			const range = ctx.this as Range;
			const frames = isFrameTreeLive(range.commonAncestorContainer)
				? collectFrameHostArgs(client, [ctx.args[0]])
				: [];
			const ret = ctx.call();
			hookFrameHosts(client, frames);
			ctx.return(ret);
		},
	});
}

export default function (client: ScramjetClient, self: typeof window) {
	proxyNodeInsertion(client, "Node.prototype.appendChild", (args) => [args[0]]);
	proxyNodeInsertion(client, "Node.prototype.insertBefore", (args) => [
		args[0],
	]);
	proxyNodeInsertion(client, "Node.prototype.replaceChild", (args) => [
		args[0],
	]);

	const variadicInsertionMethods = [
		"Element.prototype.append",
		"Element.prototype.prepend",
		"Element.prototype.before",
		"Element.prototype.after",
		"Element.prototype.replaceWith",
		"Element.prototype.replaceChildren",
		"Element.prototype.insertAdjacentElement",
		"CharacterData.prototype.before",
		"CharacterData.prototype.after",
		"CharacterData.prototype.replaceWith",
		"DocumentType.prototype.before",
		"DocumentType.prototype.after",
		"DocumentType.prototype.replaceWith",
		"Document.prototype.append",
		"Document.prototype.prepend",
		"Document.prototype.replaceChildren",
		"DocumentFragment.prototype.append",
		"DocumentFragment.prototype.prepend",
		"DocumentFragment.prototype.replaceChildren",
	];
	for (let i = 0; i < variadicInsertionMethods.length; i++) {
		proxyNodeInsertion(client, variadicInsertionMethods[i], (args) => args);
	}
	proxyRangeInsertion(client, "Range.prototype.insertNode");
	proxyRangeInsertion(client, "Range.prototype.surroundContents");

	if ("ShadowRoot" in self) {
		client.Trap("ShadowRoot.prototype.innerHTML" as any, {
			set(ctx, value: string) {
				ctx.set(value);
				hookFrameTree(client, ctx.this);
			},
		});
		proxyHtmlSink(client, "ShadowRoot.prototype.setHTMLUnsafe");
	}

	hookFrameTree(client, self.document);
}
