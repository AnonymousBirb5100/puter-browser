import { basicTest, htmlTest } from "../testcommon.ts";

export default [
	basicTest({
		name: "escape-iframe-sanity",
		js: `
			const iframe = document.createElement("iframe");
			document.body.append(iframe);
			checkglobal(iframe.contentWindow.Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-sanity-document",
		js: `
			const iframe = document.createElement("iframe");
			document.body.append(iframe);
			checkglobal(iframe.contentDocument.defaultView.Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-indirect",
		js: `
			document.open();
			document.write("<iframe />");
			document.close();
			const iframe = document.querySelector("iframe");
			checkglobal(iframe.contentWindow.Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-frames",
		js: `
			document.open();
			document.write("<iframe />");
			document.close();
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-documentwrite-before-script",
		js: `
			document.open();
			document.write('<iframe></iframe><script>checkglobal(window[0].Function("return top")());<\\/script>');
			document.close();
    `,
	}),
	htmlTest({
		name: "escape-iframe-parser-before-script",
		html: `
			<!doctype html>
			<html>
				<body>
					<iframe></iframe>
					<script>
						runTest(async () => {
							checkglobal(window[0].Function("return top")());
						}, true);
					</script>
				</body>
			</html>
		`,
		scramjetOnly: true,
	}),
	basicTest({
		name: "escape-iframe-frames-2",
		js: `
			const iframe = document.createElement("iframe");
			document.body.append(iframe);
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-appendchild",
		js: `
			const iframe = document.createElement("iframe");
			document.body.appendChild(iframe);
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-insertbefore",
		js: `
			const iframe = document.createElement("iframe");
			document.body.insertBefore(iframe, document.body.firstChild);
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-fragment",
		js: `
			const fragment = document.createDocumentFragment();
			fragment.appendChild(document.createElement("iframe"));
			document.body.appendChild(fragment);
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-replacechildren",
		js: `
			document.body.replaceChildren(document.createElement("iframe"));
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-innerhtml",
		js: `
			document.body.innerHTML = "<iframe></iframe>";
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-insertadjacenthtml",
		js: `
			document.body.insertAdjacentHTML("beforeend", "<iframe></iframe>");
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-range-fragment",
		js: `
			const range = document.createRange();
			range.selectNode(document.body);
			document.body.appendChild(range.createContextualFragment("<iframe></iframe>"));
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-childnode-after",
		js: `
			const marker = document.body.appendChild(document.createTextNode(""));
			marker.after(document.createElement("iframe"));
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-insertadjacentelement",
		js: `
			document.body.insertAdjacentElement("beforeend", document.createElement("iframe"));
			checkglobal(window[0].Function("return top")());
    `,
	}),
	basicTest({
		name: "escape-iframe-range-insertnode",
		js: `
			const range = document.createRange();
			range.selectNodeContents(document.body);
			range.collapse(false);
			range.insertNode(document.createElement("iframe"));
			checkglobal(window[0].Function("return top")());
    `,
	}),
];
