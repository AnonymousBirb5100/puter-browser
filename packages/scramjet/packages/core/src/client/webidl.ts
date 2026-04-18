import {
	Object_entries,
	Object_getOwnPropertyDescriptor,
	Object_hasOwn,
	String,
} from "@/shared/snapshot";

export const WEBIDL_PROXY_TARGETS = [
	"Audio",
	"CSSStyleDeclaration.prototype.getPropertyValue",
	"CSSStyleDeclaration.prototype.setProperty",
	"CSSStyleSheet.prototype.insertRule",
	"CSSStyleSheet.prototype.replace",
	"CSSStyleSheet.prototype.replaceSync",
	"CSSStyleValue.parse",
	"Cache.prototype.add",
	"Cache.prototype.addAll",
	"Cache.prototype.delete",
	"Cache.prototype.keys",
	"Cache.prototype.match",
	"Cache.prototype.matchAll",
	"Cache.prototype.put",
	"CacheStorage.prototype.delete",
	"CacheStorage.prototype.has",
	"CacheStorage.prototype.match",
	"CacheStorage.prototype.open",
	"DOMParser.prototype.parseFromString",
	"Document.prototype.close",
	"Document.prototype.open",
	"Document.prototype.parseHTMLUnsafe",
	"Document.prototype.querySelector",
	"Document.prototype.querySelectorAll",
	"Document.prototype.write",
	"Document.prototype.writeln",
	"Element.prototype.getAttribute",
	"Element.prototype.getAttributeNames",
	"Element.prototype.getAttributeNode",
	"Element.prototype.getHTML",
	"Element.prototype.hasAttribute",
	"Element.prototype.insertAdjacentHTML",
	"Element.prototype.removeAttribute",
	"Element.prototype.setAttribute",
	"Element.prototype.setAttributeNS",
	"Element.prototype.setAttributeNode",
	"Element.prototype.setHTMLUnsafe",
	"Element.prototype.toggleAttribute",
	"EventSource",
	"EventTarget.prototype.addEventListener",
	"EventTarget.prototype.removeEventListener",
	"FontFace",
	"Function",
	"Function.prototype.toString",
	"HTMLIFrameElement.prototype.getSVGDocument",
	"History.prototype.pushState",
	"IDBFactory.prototype.open",
	"MessagePort.prototype.postMessage",
	"Navigator.prototype.registerProtocolHandler",
	"Navigator.prototype.sendBeacon",
	"Navigator.prototype.unregisterProtocolHandler",
	"Performance.prototype.getEntries",
	"Promise.prototype.catch",
	"Range.prototype.createContextualFragment",
	"Request",
	"SharedWorker",
	"StorageManager.prototype.getDirectory",
	"Text.prototype.appendData",
	"Text.prototype.insertData",
	"Text.prototype.replaceData",
	"URL.createObjectURL",
	"URL.revokeObjectURL",
	"WebSocket",
	"WebSocket.prototype.close",
	"WebSocket.prototype.send",
	"WebSocketStream",
	"WebSocketStream.prototype.close",
	"Worker",
	"Worker.prototype.postMessage",
	"Worklet.prototype.addModule",
	"XMLHttpRequest.prototype.getAllResponseHeaders",
	"XMLHttpRequest.prototype.getResponseHeader",
	"XMLHttpRequest.prototype.open",
	"XMLHttpRequest.prototype.send",
	"XMLHttpRequest.prototype.setRequestHeader",
	"console.clear",
	"fetch",
	"importScripts",
	"self.postMessage",
	"setInterval",
	"setTimeout",
	"window.open",
	"window.postMessage",
] as const;

export const WEBIDL_TRAP_TARGETS = [
	"Attr.prototype.nodeValue",
	"Attr.prototype.value",
	"CSSRule.prototype.cssText",
	"CSSStyleDeclaration.prototype.cssText",
	"Document.prototype.URL",
	"Document.prototype.cookie",
	"Document.prototype.documentURI",
	"Document.prototype.domain",
	"Document.prototype.referrer",
	"Element.prototype.attributes",
	"Element.prototype.innerHTML",
	"Element.prototype.outerHTML",
	"Error.prepareStackTrace",
	"EventSource.prototype.url",
	"HTMLElement.prototype.style",
	"HTMLIFrameElement.prototype.contentDocument",
	"HTMLIFrameElement.prototype.contentWindow",
	"IDBDatabase.prototype.name",
	"Node.prototype.baseURI",
	"Node.prototype.textContent",
	"PerformanceEntry.prototype.name",
	"Request.prototype.url",
	"Response.prototype.headers",
	"Response.prototype.url",
	"SVGAnimatedString.prototype.animVal",
	"SVGAnimatedString.prototype.baseVal",
	"Text.prototype.wholeText",
	"WebSocket.prototype.binaryType",
	"WebSocket.prototype.bufferedAmount",
	"WebSocket.prototype.extensions",
	"WebSocket.prototype.onclose",
	"WebSocket.prototype.onerror",
	"WebSocket.prototype.onmessage",
	"WebSocket.prototype.onopen",
	"WebSocket.prototype.protocol",
	"WebSocket.prototype.readyState",
	"WebSocket.prototype.url",
	"WebSocketStream.prototype.closed",
	"WebSocketStream.prototype.opened",
	"WebSocketStream.prototype.url",
	"XMLHttpRequest.prototype.responseURL",
	"console.log",
	"origin",
	"window.frameElement",
] as const;

export const WEBIDL_CLIENT_API_TARGETS = [
	...WEBIDL_PROXY_TARGETS,
	...WEBIDL_TRAP_TARGETS,
] as const;

export type WebIDLClientApiTarget = (typeof WEBIDL_CLIENT_API_TARGETS)[number];
export type WebIDLInterceptorKind = "proxy" | "trap";

const proxyLookup: Record<string, true> = {};
for (const target of WEBIDL_PROXY_TARGETS) {
	proxyLookup[target] = true;
}
const trapLookup: Record<string, true> = {};
for (const target of WEBIDL_TRAP_TARGETS) {
	trapLookup[target] = true;
}

export function assertKnownWebIDLTarget(
	target: string,
	kind: WebIDLInterceptorKind
): asserts target is WebIDLClientApiTarget {
	const known = kind === "proxy" ? proxyLookup[target] : trapLookup[target];
	if (!known) {
		throw new TypeError(
			`[scramjet/webidl] unknown ${kind} target \"${target}\" - add it to src/client/webidl.ts`
		);
	}
}

function resolveTarget(root: any, target: string) {
	const parts = target.split(".");
	const property = parts.pop();
	if (!property) return null;

	const owner = parts.reduce((acc, part) => acc?.[part], root);
	if (!owner) return null;

	return { owner, property };
}

export function hasWebIDLTarget(root: any, target: string): boolean {
	const resolved = resolveTarget(root, target);
	if (!resolved) return false;
	return !!Object_getOwnPropertyDescriptor(resolved.owner, resolved.property);
}

function canProxy(descriptor: PropertyDescriptor | undefined): boolean {
	if (!descriptor) return false;
	if (Object_hasOwn(descriptor, "value")) {
		return typeof descriptor.value === "function";
	}
	if (descriptor.get) {
		return true;
	}
	return false;
}

function canTrap(descriptor: PropertyDescriptor | undefined): boolean {
	if (!descriptor) return false;
	return (
		Object_hasOwn(descriptor, "value") || !!descriptor.get || !!descriptor.set
	);
}

export function assertWebIDLTargetShape(
	root: any,
	target: string,
	kind: WebIDLInterceptorKind
) {
	const resolved = resolveTarget(root, target);
	if (!resolved) {
		throw new TypeError(
			`[scramjet/webidl] missing target \"${target}\" in current realm`
		);
	}

	const descriptor = Object_getOwnPropertyDescriptor(
		resolved.owner,
		resolved.property
	);
	if (kind === "proxy") {
		if (!canProxy(descriptor)) {
			throw new TypeError(
				`[scramjet/webidl] target \"${target}\" is not callable/constructable`
			);
		}
		return;
	}

	if (!canTrap(descriptor)) {
		throw new TypeError(
			`[scramjet/webidl] target \"${target}\" is not a trap-compatible property`
		);
	}
}

export type WebIDLCoverage = {
	proxy: Record<string, true>;
	trap: Record<string, true>;
};

export function createWebIDLCoverage(): WebIDLCoverage {
	return {
		proxy: {},
		trap: {},
	};
}

export function markWebIDLCoverage(
	coverage: WebIDLCoverage,
	target: string,
	kind: WebIDLInterceptorKind
) {
	if (kind === "proxy") {
		coverage.proxy[target] = true;
	} else {
		coverage.trap[target] = true;
	}
}

export function getMissingWebIDLTargets(coverage: WebIDLCoverage) {
	const missingProxy = WEBIDL_PROXY_TARGETS.filter((t) => !coverage.proxy[t]);
	const missingTrap = WEBIDL_TRAP_TARGETS.filter((t) => !coverage.trap[t]);
	return { missingProxy, missingTrap };
}

export function coverageSnapshot(coverage: WebIDLCoverage) {
	return {
		proxy: Object_entries(coverage.proxy).map(([target]) => String(target)),
		trap: Object_entries(coverage.trap).map(([target]) => String(target)),
	};
}
