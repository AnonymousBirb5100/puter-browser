import { ScramjetClient } from "@client/index";

export default function (client: ScramjetClient) {
	client.idl.operation("EventSource", {
		construct(ctx) {
			ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});

	client.idl.attribute("EventSource.prototype.url", {
		get(ctx) {
			return client.unrewriteUrl(ctx.get());
		},
	});
}
