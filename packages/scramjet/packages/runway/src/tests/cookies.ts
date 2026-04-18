import { serverTest } from "../testcommon.ts";

export default [
	serverTest({
		name: "cookies-fetch-set-cookie-race",
		autoPass: false,
		js: `
        assert(!document.cookie.includes("runway_cookie=testvalue"), "document.cookie should be empty");
		await fetch("/set-cookie");
		assert(
			document.cookie.includes("runway_cookie=testvalue"),
			"document.cookie should include value from Set-Cookie on same-origin fetch"
		);
		pass("cookie visible in document.cookie after fetch");
	`,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "").split("?")[0] || "";
				if (path !== "/set-cookie") return;
				res.writeHead(200, {
					"Content-Type": "text/plain; charset=utf-8",
					"Set-Cookie": "runway_cookie=testvalue; Path=/",
				});
				res.end("ok");
			});
		},
	}),
	serverTest({
		name: "cookies-img-set-cookie-race",
		autoPass: false,
		js: `
        assert(!document.cookie.includes("runway_cookie=testvalue"), "document.cookie should be empty");
        
        let img = new Image();
        img.src = "/set-cookie";
        
        document.body.appendChild(img);
        await new Promise(resolve => img.onerror= resolve);

		assert(
			document.cookie.includes("runway_cookie=testvalue"),
			"document.cookie should include value from Set-Cookie on same-origin fetch"
		);
		pass("cookie visible in document.cookie after fetch");
	`,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "").split("?")[0] || "";
				if (path !== "/set-cookie") return;
				res.writeHead(200, {
					"Content-Type": "text/plain; charset=utf-8",
					"Set-Cookie": "runway_cookie=testvalue; Path=/",
				});
				res.end("ok");
			});
		},
	}),
];
