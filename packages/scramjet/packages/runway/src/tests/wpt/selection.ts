function normalize(relPath: string) {
	return relPath.replaceAll("\\", "/");
}

export const REFERRER_GENERATED_ROOTS = [
	"referrer-policy/gen/iframe.http-rp/",
	"referrer-policy/gen/iframe.meta/",
	"referrer-policy/gen/top.http-rp/",
	"referrer-policy/gen/top.meta/",
];

export const REFERRER_INHERITANCE_PAGES = [
	"referrer-policy/generic/inheritance/iframe-inheritance-about-blank.html",
	"referrer-policy/generic/inheritance/iframe-inheritance-srcdoc.html",
];

export function includeReferrerGeneratedFile(relPath: string) {
	const normalized = normalize(relPath);
	return (
		REFERRER_GENERATED_ROOTS.some((root) => normalized.startsWith(root)) &&
		(normalized.endsWith(".html") || normalized.endsWith(".headers"))
	);
}

export function includeFetchMetadataGeneratedFile(relPath: string) {
	const normalized = normalize(relPath);
	return (
		normalized.startsWith("fetch/metadata/generated/") &&
		normalized.includes(".sub.html")
	);
}

export const COOKIE_WPT_FILES = [
	"cookies/attributes/expires.html",
	"cookies/attributes/invalid.html",
	"cookies/attributes/max-age.html",
	"cookies/domain/domain-attribute-missing.sub.html",
	"cookies/domain/domain-attribute-missing.sub.html.headers",
	"cookies/encoding/charset.html",
	"cookies/name/name-ctl.html",
	"cookies/name/name.html",
	"cookies/path/default.html",
	"cookies/path/match.html",
	"cookies/resources/cookie-helper.sub.js",
	"cookies/resources/cookie-test.js",
	"cookies/resources/cookie.py",
	"cookies/resources/drop.py",
	"cookies/resources/echo-cookie.html",
	"cookies/resources/echo-json.py",
	"cookies/resources/list.py",
	"cookies/resources/set-cookie.py",
	"cookies/resources/set.py",
	"cookies/resources/testharness-helpers.js",
	"cookies/value/value-ctl.html",
	"cookies/value/value.html",
] as const;

const COOKIE_WPT_FILE_SET = new Set(COOKIE_WPT_FILES);

export const COOKIE_WPT_PAGES = COOKIE_WPT_FILES.filter(
	(file) =>
		file.endsWith(".html") &&
		!file.startsWith("cookies/resources/") &&
		!file.endsWith(".headers")
);

export function includeCookieFile(relPath: string) {
	return COOKIE_WPT_FILE_SET.has(
		normalize(relPath) as (typeof COOKIE_WPT_FILES)[number]
	);
}
