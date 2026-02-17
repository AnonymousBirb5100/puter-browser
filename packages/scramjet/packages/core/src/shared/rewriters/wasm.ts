// i am a cat. i like to be petted. i like to be fed. i like to be
import { flagEnabled, ScramjetContext } from "@/shared";

export type JsRewriterOutput = {
	js: Uint8Array;
	map: Uint8Array;
	scramtag: string;
	errors: string[];
};

import { rewriteUrl, URLMeta } from "@rewriters/url";
import { htmlRules } from "@/shared/htmlRules";
import { rewriteCss } from "@rewriters/css";
import { rewriteJs } from "@rewriters/js";
import { CookieJar } from "@/shared/cookie";

let wasm_u8: Uint8Array;
export function setWasm(u8: Uint8Array | ArrayBuffer) {
	wasm_u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
	wasm = null;
	rewriters = [];
}

type WasmExports = WebAssembly.Exports & {
	memory: WebAssembly.Memory;
	wasm_alloc(len: number): number;
	wasm_dealloc(ptr: number, len: number): void;
	rewriter_new(): number;
	rewriter_free(handle: number): void;
	rewriter_rewrite_js(
		handle: number,
		jsconfig_ptr: number,
		jsconfig_len: number,
		jsflags_ptr: number,
		jsflags_len: number,
		js_ptr: number,
		js_len: number,
		base_ptr: number,
		base_len: number,
		url_ptr: number,
		url_len: number,
		sourcetag_ptr: number,
		sourcetag_len: number,
		module: number,
		out_ptr_ptr: number,
		out_len_ptr: number,
		out_err_ptr_ptr: number,
		out_err_len_ptr: number
	): number;
	rewriter_rewrite_js_bytes(
		handle: number,
		jsconfig_ptr: number,
		jsconfig_len: number,
		jsflags_ptr: number,
		jsflags_len: number,
		js_ptr: number,
		js_len: number,
		base_ptr: number,
		base_len: number,
		url_ptr: number,
		url_len: number,
		sourcetag_ptr: number,
		sourcetag_len: number,
		module: number,
		out_ptr_ptr: number,
		out_len_ptr: number,
		out_err_ptr_ptr: number,
		out_err_len_ptr: number
	): number;
};

let wasm: WasmExports | null = null;
let currentEncodeUrl: ((input: string) => string) | null = null;
const textEncoder = new TextEncoder();

function scramtag() {
	if (globalThis.crypto?.getRandomValues) {
		return ("" + 1e10).replace(/[018]/g, (c) => {
			const digit = Number(c);
			return (
				digit ^
				((globalThis.crypto.getRandomValues(new Uint8Array(1))[0] & 15) >>
					(digit / 4))
			).toString(16);
		});
	}
	return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

function assertWasm(): WasmExports {
	if (!wasm) throw new Error("wasm module not initialized");
	return wasm;
}

function allocBytes(bytes: Uint8Array): { ptr: number; len: number } {
	if (bytes.length === 0) return { ptr: 0, len: 0 };
	const exports = assertWasm();
	const ptr = exports.wasm_alloc(bytes.length) >>> 0;
	new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
	return { ptr, len: bytes.length };
}

function allocString(value: string): { ptr: number; len: number } {
	return allocBytes(textEncoder.encode(value));
}

function decode(ptr: number, len: number): string {
	if (!ptr || !len) return "";
	const exports = assertWasm();
	return textDecoder.decode(new Uint8Array(exports.memory.buffer, ptr, len));
}

function free(ptr: number, len: number) {
	if (ptr && len) {
		assertWasm().wasm_dealloc(ptr, len);
	}
}

function readU32(ptr: number) {
	return new DataView(assertWasm().memory.buffer).getUint32(ptr, true);
}

function hostEncodeUrl(
	urlPtr: number,
	urlLen: number,
	basePtr: number,
	baseLen: number,
	moduleFlag: number,
	outPtrPtr: number,
	outLenPtr: number,
	errPtrPtr: number,
	errLenPtr: number
): number {
	const exports = assertWasm();
	const view = new DataView(exports.memory.buffer);
	try {
		if (!currentEncodeUrl) throw new Error("encode_url is not a function");
		const absolute = new URL(
			decode(urlPtr, urlLen),
			decode(basePtr, baseLen)
		).toString();
		let rewritten = currentEncodeUrl(absolute);
		if (moduleFlag) rewritten += "?type=module";
		const out = allocString(rewritten);
		view.setUint32(outPtrPtr, out.ptr, true);
		view.setUint32(outLenPtr, out.len, true);
		view.setUint32(errPtrPtr, 0, true);
		view.setUint32(errLenPtr, 0, true);
		return 0;
	} catch (err) {
		const out = allocString(err instanceof Error ? err.message : String(err));
		view.setUint32(errPtrPtr, out.ptr, true);
		view.setUint32(errLenPtr, out.len, true);
		view.setUint32(outPtrPtr, 0, true);
		view.setUint32(outLenPtr, 0, true);
		return 1;
	}
}

function initSync(module: BufferSource | WebAssembly.Module) {
	const compiled = module;
	const instance = new WebAssembly.Instance(compiled, {
		env: {
			sj_encode_url: hostEncodeUrl,
		},
	});
	wasm = instance.exports as WasmExports;
	return wasm;
}

export class Rewriter {
	handle: number;

	constructor() {
		this.handle = assertWasm().rewriter_new() >>> 0;
	}

	free() {
		if (this.handle) {
			assertWasm().rewriter_free(this.handle);
			this.handle = 0;
		}
	}

	rewrite_js(
		jsconfig: object,
		jsflags: object,
		encode_url: (input: string) => string,
		js: string,
		base: string,
		url: string,
		module: boolean
	): JsRewriterOutput {
		return this.rewriteCommon(
			assertWasm().rewriter_rewrite_js,
			JSON.stringify(jsconfig),
			JSON.stringify(jsflags),
			allocString(js),
			base,
			url,
			module,
			encode_url
		);
	}

	rewrite_js_bytes(
		jsconfig: object,
		jsflags: object,
		encode_url: (input: string) => string,
		js: Uint8Array,
		base: string,
		url: string,
		module: boolean
	): JsRewriterOutput {
		return this.rewriteCommon(
			assertWasm().rewriter_rewrite_js_bytes,
			JSON.stringify(jsconfig),
			JSON.stringify(jsflags),
			allocBytes(js),
			base,
			url,
			module,
			encode_url
		);
	}

	private rewriteCommon(
		func:
			| WasmExports["rewriter_rewrite_js"]
			| WasmExports["rewriter_rewrite_js_bytes"],
		jsconfig: string,
		jsflags: string,
		jsSrc: { ptr: number; len: number },
		base: string,
		url: string,
		module: boolean,
		encode_url: (input: string) => string
	): JsRewriterOutput {
		currentEncodeUrl = encode_url;
		const cfg = allocString(jsconfig);
		const flags = allocString(jsflags);
		const b = allocString(base);
		const u = allocString(url);
		const tag = allocString(scramtag());
		const out = allocBytes(new Uint8Array(16));
		try {
			const status = func(
				this.handle,
				cfg.ptr,
				cfg.len,
				flags.ptr,
				flags.len,
				jsSrc.ptr,
				jsSrc.len,
				b.ptr,
				b.len,
				u.ptr,
				u.len,
				tag.ptr,
				tag.len,
				module ? 1 : 0,
				out.ptr,
				out.ptr + 4,
				out.ptr + 8,
				out.ptr + 12
			);

			const outPtr = readU32(out.ptr);
			const outLen = readU32(out.ptr + 4);
			const errPtr = readU32(out.ptr + 8);
			const errLen = readU32(out.ptr + 12);

			if (status !== 0) {
				const message = decode(errPtr, errLen) || "rewriter failed";
				free(errPtr, errLen);
				throw new Error(message);
			}

			const payload = decode(outPtr, outLen);
			free(outPtr, outLen);
			const parsed = JSON.parse(payload) as {
				js: number[];
				map: number[];
				scramtag: string;
				errors: string[];
			};
			return {
				js: Uint8Array.from(parsed.js),
				map: Uint8Array.from(parsed.map),
				scramtag: parsed.scramtag,
				errors: parsed.errors,
			};
		} finally {
			free(cfg.ptr, cfg.len);
			free(flags.ptr, flags.len);
			free(jsSrc.ptr, jsSrc.len);
			free(b.ptr, b.len);
			free(u.ptr, u.len);
			free(tag.ptr, tag.len);
			free(out.ptr, out.len);
			currentEncodeUrl = null;
		}
	}
}

if (Symbol.dispose) {
	Rewriter.prototype[Symbol.dispose] = Rewriter.prototype.free;
}

export const textDecoder = new TextDecoder();
let MAGIC = "\0asm".split("").map((x) => x.charCodeAt(0));

function initWasm() {
	if (wasm) return;

	if (!(wasm_u8 instanceof Uint8Array))
		throw new Error("rewriter wasm not found (was setWasm called?)");

	if (![...wasm_u8.slice(0, 4)].every((x, i) => x === MAGIC[i]))
		throw new Error(
			"rewriter wasm does not have wasm magic (was it fetched correctly?)\nrewriter wasm contents: " +
				textDecoder.decode(wasm_u8)
		);

	initSync(new WebAssembly.Module(wasm_u8 as unknown as BufferSource));
}

let rewriters = [];
export function getRewriter(
	context: ScramjetContext,
	meta: URLMeta
): [Rewriter, () => void] {
	initWasm();

	let obj: { rewriter: Rewriter; inUse: boolean };
	let index = rewriters.findIndex((x) => !x.inUse);
	let len = rewriters.length;

	if (index === -1) {
		if (flagEnabled("rewriterLogs", context, meta.base))
			console.log(`creating new rewriter, ${len} rewriters made already`);

		let rewriter = new Rewriter();
		obj = { rewriter, inUse: false };
		rewriters.push(obj);
	} else {
		obj = rewriters[index];
	}
	obj.inUse = true;

	return [obj.rewriter, () => (obj.inUse = false)];
}
