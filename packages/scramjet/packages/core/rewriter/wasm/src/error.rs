use js::RewriterError as JsRewriterError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RewriterError {
	#[error("JS: {0}")]
	Js(String),

	#[error("JS Rewriter: {0}")]
	JsRewriter(#[from] JsRewriterError),

	#[error("json error: {0}")]
	Json(#[from] serde_json::Error),
	#[error("str fromutf8 error: {0}")]
	Str(#[from] std::str::Utf8Error),
	#[error("invalid handle")]
	InvalidHandle,
	#[error("null pointer")]
	NullPointer,
	#[error("utf8 error: {0}")]
	Utf8(#[from] std::string::FromUtf8Error),
	#[error("url rewriter returned invalid utf8")]
	UrlUtf8,
	#[error("wasm memory access out of bounds")]
	OutOfBounds,

	#[error("{0} was not {1}")]
	Not(&'static str, &'static str),
}

pub type Result<T> = std::result::Result<T, RewriterError>;
