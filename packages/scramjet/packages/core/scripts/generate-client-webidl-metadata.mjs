import fs from "node:fs";
import path from "node:path";
import * as webidl2 from "webidl2";

const root =
	"/home/runner/work/browser.js/browser.js/packages/scramjet/packages/core";
const clientDir = path.join(root, "src/client");
const idlDir = path.join(clientDir, "webidl/idl");
const outputFile = path.join(clientDir, "webidl.generated.ts");

function walk(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(p));
		else if (entry.isFile() && p.endsWith(".ts")) out.push(p);
	}
	return out;
}

function extractTargets() {
	const files = walk(clientDir);
	const operations = new Set();
	const attributes = new Set();
	for (const file of files) {
		if (file.endsWith("webidl.ts") || file.endsWith("webidl.generated.ts"))
			continue;
		const text = fs.readFileSync(file, "utf8");

		for (const match of text.matchAll(
			/client\.idl\.(?:operation|attribute)\(([^,]+),/g
		)) {
			const raw = match[1].trim();
			const isTrap = match[0].includes(".attribute(");
			if (/^["']/.test(raw)) {
				(isTrap ? attributes : operations).add(raw.slice(1, -1));
			} else if (raw.startsWith("[")) {
				for (const inner of raw.matchAll(/["']([^"']+)["']/g)) {
					(isTrap ? attributes : operations).add(inner[1]);
				}
			}
		}
	}

	operations.add("MessagePort.prototype.postMessage");
	operations.add("Worker.prototype.postMessage");
	operations.add("self.postMessage");
	operations.add("Performance.prototype.getEntriesByType");
	operations.add("Performance.prototype.getEntriesByName");
	operations.add("PerformanceObserverEntryList.prototype.getEntries");
	operations.add("PerformanceObserverEntryList.prototype.getEntriesByType");
	operations.add("PerformanceObserverEntryList.prototype.getEntriesByName");

	return {
		operations: [...operations].sort(),
		attributes: [...attributes].sort(),
	};
}

function parseIdlFiles() {
	const interfaces = new Map();
	const mixins = new Map();
	const includes = new Map();
	const namespaces = new Map();
	const globals = new Set([
		"Window",
		"WorkerGlobalScope",
		"WindowOrWorkerGlobalScope",
	]);

	const files = fs
		.readdirSync(idlDir)
		.filter((f) => f.endsWith(".idl"))
		.sort();
	for (const filename of files) {
		const full = path.join(idlDir, filename);
		const source = fs.readFileSync(full, "utf8");
		const ast = webidl2.parse(source, { sourceName: filename });
		for (const def of ast) {
			if (def.type === "interface" || def.type === "callback interface") {
				const existing = interfaces.get(def.name) ?? [];
				existing.push({ def, file: filename });
				interfaces.set(def.name, existing);
			} else if (def.type === "interface mixin") {
				const existing = mixins.get(def.name) ?? [];
				existing.push({ def, file: filename });
				mixins.set(def.name, existing);
			} else if (def.type === "includes") {
				const arr = includes.get(def.target) ?? [];
				arr.push(def.includes);
				includes.set(def.target, arr);
			} else if (def.type === "namespace") {
				namespaces.set(def.name, { def, file: filename });
			}
		}
	}

	function mergedMembers(interfaceName, seen = new Set()) {
		if (seen.has(interfaceName)) return [];
		seen.add(interfaceName);

		const ifaceParts = interfaces.get(interfaceName);
		if (!ifaceParts?.length) {
			const mixinParts = mixins.get(interfaceName);
			if (!mixinParts?.length) return [];
			const mixinMembers = [];
			for (const mixin of mixinParts) {
				for (const member of mixin.def.members ?? []) {
					mixinMembers.push({ member, file: mixin.file });
				}
			}
			return mixinMembers;
		}

		const own = [];
		for (const iface of ifaceParts) {
			for (const member of iface.def.members ?? []) {
				own.push({ member, file: iface.file });
			}
			if (iface.def.inheritance) {
				own.push(...mergedMembers(iface.def.inheritance, seen));
			}
		}
		for (const mixinName of includes.get(interfaceName) ?? []) {
			const mixinParts = mixins.get(mixinName) ?? [];
			for (const mixin of mixinParts) {
				for (const member of mixin.def.members ?? []) {
					own.push({ member, file: mixin.file });
				}
			}
		}
		return own;
	}

	function findMember(interfaceName, memberName) {
		for (const entry of mergedMembers(interfaceName)) {
			if (entry.member.name !== memberName) continue;
			return entry;
		}
		return null;
	}

	function findStatic(interfaceName, memberName) {
		const ifaceParts = interfaces.get(interfaceName);
		if (!ifaceParts?.length) return null;
		for (const iface of ifaceParts) {
			for (const member of iface.def.members ?? []) {
				if (member.name === memberName && member.special === "static") {
					return { member, file: iface.file };
				}
			}
		}
		return null;
	}

	function findGlobalMember(memberName) {
		for (const globalName of globals) {
			const entry = findMember(globalName, memberName);
			if (entry) return { owner: globalName, ...entry };
		}
		return null;
	}

	function findNamespaceMember(namespaceName, memberName) {
		const ns = namespaces.get(namespaceName);
		if (!ns) return null;
		const member = (ns.def.members ?? []).find((m) => m.name === memberName);
		if (!member) return null;
		return { member, file: ns.file };
	}

	function normalizeMemberKind(member) {
		if (!member) return "unknown";
		if (member.type === "operation") return "operation";
		if (member.type === "attribute" || member.type === "field")
			return "attribute";
		if (member.type === "constructor") return "constructor";
		return "unknown";
	}

	function signatureFromMember(member, fallbackName) {
		if (!member) return fallbackName;
		if (member.type === "constructor") {
			const args = (member.arguments ?? [])
				.map((a) => a.name || "arg")
				.join(", ");
			return `constructor(${args})`;
		}
		const args = (member.arguments ?? [])
			.map((a) => a.name || "arg")
			.join(", ");
		if (member.type === "operation") return `${member.name}(${args})`;
		if (member.type === "attribute") return `${member.name}`;
		return fallbackName;
	}

	function resolveTarget(target) {
		const protoMatch = /^(?<iface>[^.]+)\.prototype\.(?<member>.+)$/.exec(
			target
		);
		if (protoMatch?.groups) {
			const { iface, member } = protoMatch.groups;
			const m = findMember(iface, member);
			if (m?.member) {
				return {
					owner: iface,
					member,
					memberKind: normalizeMemberKind(m.member),
					signature: signatureFromMember(m.member, `${iface}.${member}`),
					sourceFile: m.file,
				};
			}
			return null;
		}

		const dotMatch = /^(?<owner>[^.]+)\.(?<member>.+)$/.exec(target);
		if (dotMatch?.groups) {
			const { owner, member } = dotMatch.groups;
			const namespaceMember = findNamespaceMember(owner, member);
			if (namespaceMember?.member) {
				return {
					owner,
					member,
					memberKind: normalizeMemberKind(namespaceMember.member),
					signature: signatureFromMember(
						namespaceMember.member,
						`${owner}.${member}`
					),
					sourceFile: namespaceMember.file,
				};
			}

			const staticMember = findStatic(owner, member);
			if (staticMember?.member) {
				return {
					owner,
					member,
					memberKind: normalizeMemberKind(staticMember.member),
					signature: signatureFromMember(
						staticMember.member,
						`${owner}.${member}`
					),
					sourceFile: staticMember.file,
				};
			}

			if (owner === "window" || owner === "self") {
				const globalMember = findGlobalMember(member);
				if (globalMember) {
					return {
						owner: globalMember.owner,
						member,
						memberKind: normalizeMemberKind(globalMember.member),
						signature: signatureFromMember(
							globalMember.member,
							`${globalMember.owner}.${member}`
						),
						sourceFile: globalMember.file,
					};
				}
			}
			return null;
		}

		if (interfaces.has(target)) {
			const iface = interfaces.get(target)[0];
			return {
				owner: target,
				member: "constructor",
				memberKind: "constructor",
				signature: `new ${target}(...)`,
				sourceFile: iface.file,
			};
		}

		const globalMember = findGlobalMember(target);
		if (globalMember) {
			return {
				owner: globalMember.owner,
				member: target,
				memberKind: normalizeMemberKind(globalMember.member),
				signature: signatureFromMember(
					globalMember.member,
					`${globalMember.owner}.${target}`
				),
				sourceFile: globalMember.file,
			};
		}

		return null;
	}

	return { resolveTarget };
}

const targets = extractTargets();
const resolver = parseIdlFiles();

const metadata = {};
const unresolved = [];
for (const target of targets.operations) {
	const resolved = resolver.resolveTarget(target);
	if (!resolved) {
		unresolved.push(target);
		metadata[target] = {
			target,
			interceptorKind: "operation",
			memberKind: "unknown",
			owner: "unknown",
			member: target,
			signature: target,
			sourceFile: "unresolved",
		};
		continue;
	}
	metadata[target] = {
		target,
		interceptorKind: "operation",
		...resolved,
	};
}
for (const target of targets.attributes) {
	const resolved = resolver.resolveTarget(target);
	if (!resolved) {
		unresolved.push(target);
		metadata[target] = {
			target,
			interceptorKind: "attribute",
			memberKind: "unknown",
			owner: "unknown",
			member: target,
			signature: target,
			sourceFile: "unresolved",
		};
		continue;
	}
	metadata[target] = {
		target,
		interceptorKind: "attribute",
		...resolved,
	};
}

const operationTargets = targets.operations;
const attributeTargets = targets.attributes;

const output = `// GENERATED FILE - DO NOT EDIT\n// Generated by scripts/generate-client-webidl-metadata.mjs from src/client/webidl/idl/*.idl\n\nexport const WEBIDL_OPERATION_TARGETS = ${JSON.stringify(operationTargets, null, 2)} as const;\nexport const WEBIDL_ATTRIBUTE_TARGETS = ${JSON.stringify(attributeTargets, null, 2)} as const;\nexport const WEBIDL_CLIENT_TARGETS = [...WEBIDL_OPERATION_TARGETS, ...WEBIDL_ATTRIBUTE_TARGETS] as const;\n\nexport type WebIDLOperationTarget = (typeof WEBIDL_OPERATION_TARGETS)[number];\nexport type WebIDLAttributeTarget = (typeof WEBIDL_ATTRIBUTE_TARGETS)[number];\nexport type WebIDLClientTarget = (typeof WEBIDL_CLIENT_TARGETS)[number];\n\nexport type WebIDLMemberMetadata = {\n  target: string;\n  interceptorKind: 'operation' | 'attribute';\n  memberKind: 'operation' | 'attribute' | 'constructor' | 'unknown';\n  owner: string;\n  member: string;\n  signature: string;\n  sourceFile: string;\n};\n\nexport const WEBIDL_METADATA: Record<WebIDLClientTarget, WebIDLMemberMetadata> = ${JSON.stringify(metadata, null, 2)} as Record<WebIDLClientTarget, WebIDLMemberMetadata>;\nexport const WEBIDL_UNRESOLVED_TARGETS = ${JSON.stringify([...new Set(unresolved)].sort(), null, 2)} as const;\n`;

fs.writeFileSync(outputFile, output);

if (unresolved.length > 0) {
	console.error("[webidl] unresolved targets:");
	for (const target of [...new Set(unresolved)].sort()) {
		console.error(` - ${target}`);
	}
}

console.log(`generated ${path.relative(root, outputFile)}`);
