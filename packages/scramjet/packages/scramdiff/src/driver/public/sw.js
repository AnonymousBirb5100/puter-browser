// Scramjet service worker for the scramdiff harness origin.
//
// Identical in shape to runway's SW: import the controller, skip waiting so
// the first bootstrap claims immediately, and route every matching request
// through scramjet. The target page (top-level navigated to a scramjet proxy
// URL on this same origin) is handled by $scramjetController.route.
importScripts("/controller/controller.sw.js");

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

addEventListener("fetch", (e) => {
	if ($scramjetController.shouldRoute(e)) {
		e.respondWith($scramjetController.route(e));
	}
});
