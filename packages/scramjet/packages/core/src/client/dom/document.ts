import { IncrementalHtmlRewriter, rewriteHtml } from "@rewriters/html";
import { ScramjetClient } from "@client/index";
import { String, _URL } from "@/shared/snapshot";
import { createReferrerString } from "@/fetch/util";
import { hookFrameTree } from "./frame";

export default function (client: ScramjetClient, _self: Self) {
	const tostring = String;

	function resetDocumentWriter(document: Document) {
		client.box.writeRewriters.delete(document);
	}

	function getDocumentWriter(document: Document) {
		let writer = client.box.writeRewriters.get(document);
		if (!writer) {
			writer = new IncrementalHtmlRewriter(client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "Document.prototype.write",
			});
			client.box.writeRewriters.set(document, writer);
		}

		return writer;
	}

	function writeRewrittenHtml(document: Document, html: string): void {
		// Native document.write executes scripts before returning, so frame
		// markup before a script has to be committed and hooked first.
		const lower = html.toLowerCase();
		let index = 0;

		for (;;) {
			let scriptStart = lower.indexOf("<script", index);
			while (scriptStart !== -1) {
				const next = lower.charCodeAt(scriptStart + "<script".length);
				if (next <= 32 || next === 47 || next === 62) break;
				scriptStart = lower.indexOf("<script", scriptStart + 1);
			}
			if (scriptStart === -1) {
				if (index < html.length) {
					client.natives.call(
						"Document.prototype.write",
						document,
						html.slice(index)
					);
					hookFrameTree(client, document);
				}
				return;
			}

			if (scriptStart > index) {
				client.natives.call(
					"Document.prototype.write",
					document,
					html.slice(index, scriptStart)
				);
				hookFrameTree(client, document);
			}

			const openEnd = lower.indexOf(">", scriptStart);
			if (openEnd === -1) {
				client.natives.call(
					"Document.prototype.write",
					document,
					html.slice(scriptStart)
				);
				return;
			}

			const closeStart = lower.indexOf("</script", openEnd + 1);
			const scriptEnd =
				closeStart === -1
					? html.length
					: lower.indexOf(">", closeStart) + 1 || html.length;
			client.natives.call(
				"Document.prototype.write",
				document,
				html.slice(scriptStart, scriptEnd)
			);
			hookFrameTree(client, document);
			index = scriptEnd;
		}
	}

	client.Proxy(
		["Document.prototype.querySelector", "Document.prototype.querySelectorAll"],
		{
			apply(ctx) {
				ctx.args[0] = String(ctx.args[0]).replace(
					/((?:^|\s)\b\w+\[(?:src|href|data-href))[\^]?(=['"]?(?:https?[:])?\/\/)/,
					"$1*$2"
				);
			},
		}
	);

	client.Proxy("Document.prototype.write", {
		apply(ctx) {
			const writer = getDocumentWriter(ctx.this);
			ctx.return(writeRewrittenHtml(ctx.this, writer.write(ctx.args.join(""))));
		},
	});

	client.Proxy("Document.prototype.open", {
		apply(ctx) {
			resetDocumentWriter(ctx.this);
		},
	});

	client.Trap("Document.prototype.referrer", {
		get() {
			if (!client.history) return "";
			if (client.history.length < 2) return "";
			const lastState = client.history[client.history.length - 2];
			const referrerURL = new _URL(lastState.url);
			return createReferrerString(
				referrerURL,
				client.url,
				lastState.refererPolicy
			);
		},
	});

	client.Proxy("Document.prototype.writeln", {
		apply(ctx) {
			const writer = getDocumentWriter(ctx.this);
			ctx.return(
				writeRewrittenHtml(ctx.this, writer.write(ctx.args.join("") + "\n"))
			);
		},
	});

	client.Proxy("Document.prototype.close", {
		apply(ctx) {
			const writer = client.box.writeRewriters.get(ctx.this);
			if (writer) {
				try {
					const remaining = writer.end();
					if (remaining) {
						writeRewrittenHtml(ctx.this, remaining);
					}
				} finally {
					resetDocumentWriter(ctx.this);
				}
			}
			const ret = ctx.call();
			hookFrameTree(client, ctx.this);
			ctx.return(ret);
		},
	});

	client.Proxy("Document.prototype.parseHTMLUnsafe", {
		apply(ctx) {
			ctx.args[0] = rewriteHtml(ctx.args[0], client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "Document.prototype.parseHTMLUnsafe",
			});
		},
	});
}
