import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	client.idl.operation("IDBFactory.prototype.open", {
		apply(ctx) {
			ctx.args[0] = `${client.url.origin}@${ctx.args[0]}`;
		},
	});

	client.idl.attribute("IDBDatabase.prototype.name", {
		get(ctx) {
			const name = String(ctx.get());

			return name.substring(name.indexOf("@") + 1);
		},
	});
}
