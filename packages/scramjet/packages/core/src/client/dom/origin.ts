import { ScramjetClient } from "@client/index";

export default function (client: ScramjetClient, _self: Self) {
	client.idl.attribute("origin", {
		get() {
			// TODO: this isn't right!!
			return client.url.origin;
		},
		set() {
			return false;
		},
	});

	client.idl.attribute("Document.prototype.URL", {
		get() {
			return client.url.href;
		},
		set() {
			return false;
		},
	});

	client.idl.attribute("Document.prototype.documentURI", {
		get() {
			return client.url.href;
		},
		set() {
			return false;
		},
	});

	client.idl.attribute("Document.prototype.domain", {
		get() {
			return client.url.hostname;
		},
		set() {
			return false;
		},
	});
}
