import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient, _self: Self) {
	client.idl.operation("CacheStorage.prototype.open", {
		apply(ctx) {
			ctx.args[0] = `${client.url.origin}@${ctx.args[0]}`;
		},
	});

	client.idl.operation("CacheStorage.prototype.has", {
		apply(ctx) {
			ctx.args[0] = `${client.url.origin}@${ctx.args[0]}`;
		},
	});

	client.idl.operation("CacheStorage.prototype.match", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
		},
	});

	client.idl.operation("CacheStorage.prototype.delete", {
		apply(ctx) {
			ctx.args[0] = `${client.url.origin}@${ctx.args[0]}`;
		},
	});

	client.idl.operation("Cache.prototype.add", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
		},
	});

	client.idl.operation("Cache.prototype.addAll", {
		apply(ctx) {
			const requests = [...ctx.args[0]];
			for (let i = 0; i < requests.length; i++) {
				const url = String(requests[i]);
				requests[i] = client.rewriteUrl(url);
			}
			ctx.args[0] = requests;
		},
	});

	client.idl.operation("Cache.prototype.put", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
		},
	});

	client.idl.operation("Cache.prototype.match", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
		},
	});

	client.idl.operation("Cache.prototype.matchAll", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
		},
	});

	client.idl.operation("Cache.prototype.keys", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
		},
	});

	client.idl.operation("Cache.prototype.delete", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
		},
	});
}
