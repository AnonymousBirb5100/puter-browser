import {
	Error,
	Object_entries,
	Object_getOwnPropertyDescriptor,
	Object_hasOwn,
	String,
} from "@/shared/snapshot";
import {
	WEBIDL_ATTRIBUTE_TARGETS,
	WEBIDL_CLIENT_TARGETS,
	WEBIDL_METADATA,
	WEBIDL_OPERATION_TARGETS,
	type WebIDLAttributeTarget,
	type WebIDLClientTarget,
	type WebIDLMemberMetadata,
	type WebIDLOperationTarget,
} from "@client/webidl.generated";

export {
	WEBIDL_ATTRIBUTE_TARGETS,
	WEBIDL_CLIENT_TARGETS,
	WEBIDL_METADATA,
	WEBIDL_OPERATION_TARGETS,
	type WebIDLAttributeTarget,
	type WebIDLClientTarget,
	type WebIDLMemberMetadata,
	type WebIDLOperationTarget,
};

const operationLookup: Record<string, true> = {};
for (const target of WEBIDL_OPERATION_TARGETS) {
	operationLookup[target] = true;
}
const attributeLookup: Record<string, true> = {};
for (const target of WEBIDL_ATTRIBUTE_TARGETS) {
	attributeLookup[target] = true;
}

export function getWebIDLMetadata(
	target: WebIDLClientTarget
): WebIDLMemberMetadata {
	return WEBIDL_METADATA[target];
}

export function assertKnownWebIDLTarget(
	target: string,
	kind: "operation" | "attribute"
): asserts target is WebIDLClientTarget {
	const known =
		kind === "operation" ? operationLookup[target] : attributeLookup[target];
	if (!known) {
		throw new Error(
			`[scramjet/webidl] unknown ${kind} target "${target}" - regenerate src/client/webidl.generated.ts`
		);
	}
}

function resolveTarget(root: any, target: string) {
	const parts = target.split(".");
	const property = parts.pop();
	if (!property) return null;

	const owner = parts.reduce((acc, part) => acc?.[part], root);
	if (!owner) return null;

	return { owner, property };
}

export function hasWebIDLTarget(root: any, target: string): boolean {
	const resolved = resolveTarget(root, target);
	if (!resolved) return false;
	return !!Object_getOwnPropertyDescriptor(resolved.owner, resolved.property);
}

function canInterceptOperation(
	descriptor: PropertyDescriptor | undefined
): boolean {
	if (!descriptor) return false;
	if (Object_hasOwn(descriptor, "value")) {
		return typeof descriptor.value === "function";
	}
	if (descriptor.get) {
		return true;
	}
	return false;
}

function canInterceptAttribute(
	descriptor: PropertyDescriptor | undefined
): boolean {
	if (!descriptor) return false;
	return (
		Object_hasOwn(descriptor, "value") || !!descriptor.get || !!descriptor.set
	);
}

export function assertWebIDLTargetShape(
	root: any,
	target: string,
	kind: "operation" | "attribute"
) {
	const resolved = resolveTarget(root, target);
	if (!resolved) {
		throw new Error(
			`[scramjet/webidl] missing target "${target}" in current realm`
		);
	}

	const descriptor = Object_getOwnPropertyDescriptor(
		resolved.owner,
		resolved.property
	);
	if (kind === "operation") {
		if (!canInterceptOperation(descriptor)) {
			throw new Error(
				`[scramjet/webidl] target "${target}" is not operation-compatible`
			);
		}
		return;
	}

	if (!canInterceptAttribute(descriptor)) {
		throw new Error(
			`[scramjet/webidl] target "${target}" is not attribute-compatible`
		);
	}
}

export type WebIDLCoverage = {
	operation: Record<string, true>;
	attribute: Record<string, true>;
};

export function createWebIDLCoverage(): WebIDLCoverage {
	return {
		operation: {},
		attribute: {},
	};
}

export function markWebIDLCoverage(
	coverage: WebIDLCoverage,
	target: string,
	kind: "operation" | "attribute"
) {
	if (kind === "operation") {
		coverage.operation[target] = true;
	} else {
		coverage.attribute[target] = true;
	}
}

export function getMissingWebIDLTargets(coverage: WebIDLCoverage) {
	const missingOperations = WEBIDL_OPERATION_TARGETS.filter(
		(target) => !coverage.operation[target]
	);
	const missingAttributes = WEBIDL_ATTRIBUTE_TARGETS.filter(
		(target) => !coverage.attribute[target]
	);
	return { missingOperations, missingAttributes };
}

export function coverageSnapshot(coverage: WebIDLCoverage) {
	return {
		operation: Object_entries(coverage.operation).map(([target]) =>
			String(target)
		),
		attribute: Object_entries(coverage.attribute).map(([target]) =>
			String(target)
		),
	};
}
