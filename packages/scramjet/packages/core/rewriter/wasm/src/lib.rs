pub mod error;

use error::{Result, RewriterError};
use js::cfg::{Config, Flags, UrlRewriter};
use oxc::allocator::{Allocator, StringBuilder};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

thread_local! {
	static REWRITERS: RefCell<std::vec::Vec<Option<js::Rewriter>>> = const { RefCell::new(std::vec::Vec::new()) };
}

#[link(wasm_import_module = "env")]
unsafe extern "C" {
	fn sj_encode_url(
		url_ptr: u32,
		url_len: u32,
		base_ptr: u32,
		base_len: u32,
		module: u32,
		out_ptr_ptr: u32,
		out_len_ptr: u32,
		err_ptr_ptr: u32,
		err_len_ptr: u32,
	) -> u32;
}

#[derive(Deserialize)]
struct JsConfigIn {
	prefix: String,
	wrapfn: String,
	wrappropertybase: String,
	wrappropertyfn: String,
	cleanrestfn: String,
	importfn: String,
	rewritefn: String,
	wrappostmessagefn: String,
	metafn: String,
	pushsourcemapfn: String,
	trysetfn: String,
	templocid: String,
	tempunusedid: String,
}

#[derive(Deserialize)]
struct JsFlagsIn {
	sourcemaps: bool,
	#[serde(rename = "captureErrors")]
	capture_errors: bool,
	scramitize: bool,
	#[serde(rename = "strictRewrites")]
	strict_rewrites: bool,
	#[serde(rename = "destructureRewrites")]
	destructure_rewrites: bool,
}

#[derive(Serialize)]
struct JsRewriterOutput {
	js: std::vec::Vec<u8>,
	map: std::vec::Vec<u8>,
	scramtag: String,
	errors: std::vec::Vec<String>,
}

struct HostUrlRewriter;

impl UrlRewriter for HostUrlRewriter {
	fn rewrite(
		&self,
		_cfg: &Config,
		flags: &Flags,
		url: &str,
		builder: &mut StringBuilder,
		module: bool,
	) -> std::result::Result<(), Box<dyn std::error::Error + Sync + Send>> {
		let mut out_ptr = 0u32;
		let mut out_len = 0u32;
		let mut err_ptr = 0u32;
		let mut err_len = 0u32;

		let status = unsafe {
			sj_encode_url(
				url.as_ptr() as u32,
				url.len() as u32,
				flags.base.as_ptr() as u32,
				flags.base.len() as u32,
				u32::from(module),
				(&mut out_ptr as *mut u32) as u32,
				(&mut out_len as *mut u32) as u32,
				(&mut err_ptr as *mut u32) as u32,
				(&mut err_len as *mut u32) as u32,
			)
		};

		if status != 0 {
			let msg = if err_len == 0 {
				"url rewriter failed".to_string()
			} else {
				let bytes = get_bytes(err_ptr, err_len)?;
				String::from_utf8(bytes.to_vec())
					.unwrap_or_else(|_| "url rewriter failed".to_string())
			};
			if err_len != 0 {
				wasm_dealloc(err_ptr, err_len);
			}
			return Err(Box::new(RewriterError::Js(msg)));
		}

		let rewritten = String::from_utf8(get_bytes(out_ptr, out_len)?.to_vec())
			.map_err(|_| RewriterError::UrlUtf8)?;
		wasm_dealloc(out_ptr, out_len);

		builder.push_str(&rewritten);
		Ok(())
	}
}

fn get_bytes(ptr: u32, len: u32) -> Result<&'static [u8]> {
	if len == 0 {
		return Ok(&[]);
	}
	if ptr == 0 {
		return Err(RewriterError::NullPointer);
	}
	Ok(unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) })
}

fn parse_json<T: serde::de::DeserializeOwned>(ptr: u32, len: u32) -> Result<T> {
	let bytes = get_bytes(ptr, len)?;
	Ok(serde_json::from_slice(bytes)?)
}

fn make_config(input: JsConfigIn) -> Config {
	Config {
		prefix: input.prefix,
		wrapfn: input.wrapfn,
		wrappropertybase: input.wrappropertybase,
		wrappropertyfn: input.wrappropertyfn,
		cleanrestfn: input.cleanrestfn,
		importfn: input.importfn,
		rewritefn: input.rewritefn,
		wrappostmessagefn: input.wrappostmessagefn,
		metafn: input.metafn,
		pushsourcemapfn: input.pushsourcemapfn,
		trysetfn: input.trysetfn,
		templocid: input.templocid,
		tempunusedid: input.tempunusedid,
	}
}

fn make_flags(input: JsFlagsIn, base: String, sourcetag: String, is_module: bool) -> Flags {
	Flags {
		base,
		sourcetag,
		is_module,
		do_sourcemaps: input.sourcemaps,
		capture_errors: input.capture_errors,
		scramitize: input.scramitize,
		strict_rewrites: input.strict_rewrites,
		destructure_rewrites: input.destructure_rewrites,
	}
}

fn write_u32(ptr: u32, value: u32) {
	unsafe {
		(ptr as *mut u32).write_unaligned(value);
	}
}

fn set_error(out_err_ptr_ptr: u32, out_err_len_ptr: u32, err: RewriterError) {
	let msg = err.to_string().into_bytes();
	let len = msg.len() as u32;
	let ptr = wasm_alloc(len);
	if len != 0 {
		unsafe {
			std::ptr::copy_nonoverlapping(msg.as_ptr(), ptr as *mut u8, len as usize);
		}
	}
	write_u32(out_err_ptr_ptr, ptr);
	write_u32(out_err_len_ptr, len);
}

fn do_rewrite(
	handle: u32,
	jsconfig_ptr: u32,
	jsconfig_len: u32,
	jsflags_ptr: u32,
	jsflags_len: u32,
	js: &str,
	base_ptr: u32,
	base_len: u32,
	url_ptr: u32,
	url_len: u32,
	sourcetag_ptr: u32,
	sourcetag_len: u32,
	module: bool,
) -> Result<std::vec::Vec<u8>> {
	let jsconfig: JsConfigIn = parse_json(jsconfig_ptr, jsconfig_len)?;
	let jsflags: JsFlagsIn = parse_json(jsflags_ptr, jsflags_len)?;
	let base = std::str::from_utf8(get_bytes(base_ptr, base_len)?)?.to_string();
	let url = std::str::from_utf8(get_bytes(url_ptr, url_len)?)?.to_string();
	let sourcetag = std::str::from_utf8(get_bytes(sourcetag_ptr, sourcetag_len)?)?.to_string();

	let config = make_config(jsconfig);
	let flags = make_flags(jsflags, base, sourcetag, module);
	let rewriter = HostUrlRewriter;

	REWRITERS.with(|rewriters| {
		let mut rewriters = rewriters.borrow_mut();
		let slot = rewriters
			.get_mut((handle - 1) as usize)
			.and_then(Option::as_mut)
			.ok_or(RewriterError::InvalidHandle)?;

		let alloc = Allocator::default();
		let out = slot
			.rewrite(&alloc, js, config, flags, &rewriter)
			.map_err(RewriterError::from)?;

		#[cfg(feature = "debug")]
		let errors: std::vec::Vec<String> = {
			let src = std::sync::Arc::new(
				oxc::diagnostics::NamedSource::new(url, js.to_string()).with_language("javascript"),
			);
			out.errors
				.into_iter()
				.map(|x| format!("{}", x.with_source_code(src.clone())))
				.collect()
		};

		#[cfg(not(feature = "debug"))]
		let errors: std::vec::Vec<String> = {
			let _ = url;
			std::vec::Vec::new()
		};

		let payload = JsRewriterOutput {
			js: out.js.to_vec(),
			map: out.sourcemap.to_vec(),
			scramtag: out.flags.sourcetag,
			errors,
		};

		Ok(serde_json::to_vec(&payload)?)
	})
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_alloc(len: u32) -> u32 {
	if len == 0 {
		return 0;
	}
	let mut buf = std::vec::Vec::<u8>::with_capacity(len as usize);
	let ptr = buf.as_mut_ptr();
	std::mem::forget(buf);
	ptr as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_dealloc(ptr: u32, len: u32) {
	if ptr == 0 || len == 0 {
		return;
	}
	unsafe {
		drop(std::vec::Vec::from_raw_parts(
			ptr as *mut u8,
			len as usize,
			len as usize,
		));
	}
}

#[unsafe(no_mangle)]
pub extern "C" fn rewriter_new() -> u32 {
	REWRITERS.with(|rewriters| {
		let mut rewriters = rewriters.borrow_mut();
		rewriters.push(Some(js::Rewriter::new()));
		rewriters.len() as u32
	})
}

#[unsafe(no_mangle)]
pub extern "C" fn rewriter_free(handle: u32) {
	if handle == 0 {
		return;
	}
	REWRITERS.with(|rewriters| {
		let mut rewriters = rewriters.borrow_mut();
		if let Some(slot) = rewriters.get_mut((handle - 1) as usize) {
			*slot = None;
		}
	});
}

#[allow(clippy::too_many_arguments)]
#[unsafe(no_mangle)]
pub extern "C" fn rewriter_rewrite_js(
	handle: u32,
	jsconfig_ptr: u32,
	jsconfig_len: u32,
	jsflags_ptr: u32,
	jsflags_len: u32,
	js_ptr: u32,
	js_len: u32,
	base_ptr: u32,
	base_len: u32,
	url_ptr: u32,
	url_len: u32,
	sourcetag_ptr: u32,
	sourcetag_len: u32,
	module: u32,
	out_ptr_ptr: u32,
	out_len_ptr: u32,
	out_err_ptr_ptr: u32,
	out_err_len_ptr: u32,
) -> u32 {
	let js = match std::str::from_utf8(get_bytes(js_ptr, js_len).unwrap_or(&[])) {
		Ok(x) => x,
		Err(err) => {
			set_error(out_err_ptr_ptr, out_err_len_ptr, RewriterError::Str(err));
			return 1;
		}
	};

	match do_rewrite(
		handle,
		jsconfig_ptr,
		jsconfig_len,
		jsflags_ptr,
		jsflags_len,
		js,
		base_ptr,
		base_len,
		url_ptr,
		url_len,
		sourcetag_ptr,
		sourcetag_len,
		module != 0,
	) {
		Ok(out) => {
			let len = out.len() as u32;
			let ptr = wasm_alloc(len);
			if len != 0 {
				unsafe {
					std::ptr::copy_nonoverlapping(out.as_ptr(), ptr as *mut u8, len as usize);
				}
			}
			write_u32(out_ptr_ptr, ptr);
			write_u32(out_len_ptr, len);
			write_u32(out_err_ptr_ptr, 0);
			write_u32(out_err_len_ptr, 0);
			0
		}
		Err(err) => {
			set_error(out_err_ptr_ptr, out_err_len_ptr, err);
			1
		}
	}
}

#[allow(clippy::too_many_arguments)]
#[unsafe(no_mangle)]
pub extern "C" fn rewriter_rewrite_js_bytes(
	handle: u32,
	jsconfig_ptr: u32,
	jsconfig_len: u32,
	jsflags_ptr: u32,
	jsflags_len: u32,
	js_ptr: u32,
	js_len: u32,
	base_ptr: u32,
	base_len: u32,
	url_ptr: u32,
	url_len: u32,
	sourcetag_ptr: u32,
	sourcetag_len: u32,
	module: u32,
	out_ptr_ptr: u32,
	out_len_ptr: u32,
	out_err_ptr_ptr: u32,
	out_err_len_ptr: u32,
) -> u32 {
	let js = match get_bytes(js_ptr, js_len) {
		Ok(bytes) => unsafe { std::str::from_utf8_unchecked(bytes) },
		Err(err) => {
			set_error(out_err_ptr_ptr, out_err_len_ptr, err);
			return 1;
		}
	};

	match do_rewrite(
		handle,
		jsconfig_ptr,
		jsconfig_len,
		jsflags_ptr,
		jsflags_len,
		js,
		base_ptr,
		base_len,
		url_ptr,
		url_len,
		sourcetag_ptr,
		sourcetag_len,
		module != 0,
	) {
		Ok(out) => {
			let len = out.len() as u32;
			let ptr = wasm_alloc(len);
			if len != 0 {
				unsafe {
					std::ptr::copy_nonoverlapping(out.as_ptr(), ptr as *mut u8, len as usize);
				}
			}
			write_u32(out_ptr_ptr, ptr);
			write_u32(out_len_ptr, len);
			write_u32(out_err_ptr_ptr, 0);
			write_u32(out_err_len_ptr, 0);
			0
		}
		Err(err) => {
			set_error(out_err_ptr_ptr, out_err_len_ptr, err);
			1
		}
	}
}
