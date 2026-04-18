import { ScramjetClient } from "@client/index";

export default function (client: ScramjetClient) {
	client.WebIDLProxy("EventSource", {
		construct(ctx) {
			ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});

	client.WebIDLTrap("EventSource.prototype.url", {
		get(ctx) {
			return client.unrewriteUrl(ctx.get());
		},
	});
}
