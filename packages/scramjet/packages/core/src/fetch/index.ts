import {
	BareCompatibleClient,
	BareResponse,
	ProxyTransport,
	BareRequestInit,
} from "@mercuryworkshop/proxy-transports";

import { type URLMeta } from "@rewriters/url";
import { ScramjetHeaders } from "@/shared/headers";
import { HtmlRewriterHooks, ScramjetContext } from "@/shared";
import { Tap, TapInstance } from "@/Tap";
import { doHandleFetch } from "./fetch";
import { _URL, _Map } from "@/shared/snapshot";

export interface ScramjetFetchRequest {
	rawUrl: URL;
	rawReferrer: string | null;
	destination: RequestDestination;
	mode: RequestMode;
	referrer: string;
	method: string;
	body: BodyType | null;
	cache: RequestCache;

	initialHeaders: ScramjetHeaders;

	rawClientUrl?: URL;

	/** The service worker FetchEvent.clientId that originated this request. */
	clientId: string;
}

export interface ScramjetFetchParsed {
	url: _URL;
	clientUrl?: _URL;
	referrerSourceUrl?: _URL | null;
	hadExtraParams: boolean;
	/** True when this request follows a redirect chain that passed through a cross-site origin.
	 *  Used to enforce SameSite "cross-site redirect poisoning" semantics. */
	crossSiteRedirect: boolean;

	/**
	 * Worst-case Sec-Fetch-Site classification accumulated across the redirect
	 * chain that led to this request. Set on each redirect via the `sj$fs` URL
	 * parameter; combined with the immediate origin↔URL relation when emitting
	 * the Sec-Fetch-Site request header.
	 */
	fetchSiteState?: "same-origin" | "same-site" | "cross-site";

	/**
	 * Origin of the page that initiated the original (pre-redirect) request.
	 * Stored on every redirect via the `sj$io` URL parameter so that
	 * Sec-Fetch-Site can compare against the *real* initiator even when
	 * `request.rawReferrer` has been replaced by an intermediate hop's URL.
	 */
	fetchInitiatorOrigin?: string;

	/**
	 * Whether the original request explicitly requested credential inclusion.
	 * Set via the `sj$cred` URL parameter from the client-side fetch proxy
	 * (since `event.request.credentials` inside a service worker doesn't
	 * reliably reflect the page's intent). Used to gate
	 * Sec-Fetch-Storage-Access.
	 */
	fetchCredentialsInclude?: boolean;

	/**
	 * The page's intended `RequestInit.mode` value (or fetch's "cors" default).
	 * Set via the `sj$mode` URL parameter from the client-side fetch / Request
	 * proxy. Used to compute Sec-Fetch-Mode for fetch() / new Request()
	 * calls — `event.request.mode` from the SW reflects the proxy URL
	 * relationship (always same-origin to the page) and is meaningless to the
	 * destination.
	 */
	fetchMode?: RequestMode;

	/**
	 * True when this request was initiated by an actual `<iframe>` element
	 * inside the proxied site (i.e. a real sub-frame). Set via the `isIframe`
	 * URL parameter, which the HTML rule for `<iframe src=…>` stamps onto the
	 * rewritten URL. Used to distinguish a true sub-frame navigation from the
	 * runway harness's wrapper iframe so that Sec-Fetch-Dest emits "document"
	 * for the latter (top-level emulation) and "iframe" for the former.
	 */
	isIframe?: boolean;

	/**
	 * Page-side override for `request.destination`. Currently set by the HTML
	 * rule for `<link rel="prefetch|preload|modulepreload" as="X">` because
	 * `event.request.destination` arrives at the SW as `""` for those even
	 * though the network request uses `X`. Read from the `sj$dest` URL
	 * parameter. Used directly as Sec-Fetch-Dest when present.
	 */
	fetchDest?: string;

	meta: URLMeta;
	scriptType: "module" | "regular";
	referrerPolicy?: string;
	trackedClient?: ScramjetFetchTrackedClient;
}

export interface ScramjetFetchResponse {
	body: BodyType;
	headers: ScramjetHeaders;
	status: number;
	statusText: string;
}

export type CookieSyncEntry = {
	url: URL;
	cookie: string;
};

export type CookieSyncOptions = {
	clear?: boolean;
	destination?: RequestDestination;
};

export type FetchHandlerInit = {
	transport: ProxyTransport;
	context: ScramjetContext;
	crossOriginIsolated?: boolean;

	sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions
	) => Promise<void>;
	fetchDataUrl(dataUrl: string): Promise<BareResponse>;
	fetchBlobUrl(blobUrl: string): Promise<BareResponse>;
};

export type TrackedHistoryState = {
	url: string;
	refererPolicy?: string;
};
export class ScramjetFetchTrackedClient {
	history: TrackedHistoryState[] = [];
	constructor(public clientId: string) {}
}

// eslint-disable-next-line scramjet-core/no-globals
export class ScramjetFetchHandler extends EventTarget {
	public client: BareCompatibleClient;
	public crossOriginIsolated: boolean = false;
	public context: ScramjetContext;

	public trackedClients = new _Map() as _Map<
		string,
		ScramjetFetchTrackedClient
	>;

	public hooks: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
		};
		fetch: TapInstance<FetchHooks>;
	};

	public fetchDataUrl: (dataUrl: string) => Promise<Response>;
	public fetchBlobUrl: (blobUrl: string) => Promise<Response>;
	public sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions
	) => Promise<void>;

	constructor(init: FetchHandlerInit) {
		super();
		this.client = new BareCompatibleClient(init.transport);
		this.context = init.context;
		this.crossOriginIsolated = init.crossOriginIsolated || false;
		this.sendSetCookie = init.sendSetCookie;
		this.fetchDataUrl = init.fetchDataUrl;
		this.fetchBlobUrl = init.fetchBlobUrl;
		this.hooks = {
			rewriter: {
				html: Tap.create<HtmlRewriterHooks>(),
			},
			fetch: Tap.create<FetchHooks>(),
		};
		this.context.hooks = {
			rewriter: this.hooks.rewriter,
		};
	}

	async handleFetch(
		request: ScramjetFetchRequest
	): Promise<ScramjetFetchResponse> {
		return doHandleFetch(this, request);
	}
}
export type FetchHooks = {
	intercept: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
		};
		props: {
			response?: ScramjetFetchResponse;
		};
	};
	request: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
			client: BareCompatibleClient;
		};
		props: {
			init: BareRequestInit;
			url: URL;
			earlyResponse?: BareResponse;
		};
	};
	preresponse: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
		};
		props: {
			response: BareResponse;
		};
	};
	response: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
		};
		props: {
			response: ScramjetFetchResponse;
		};
	};
};

export type BodyType = string | ArrayBuffer | Blob | ReadableStream<any>;
