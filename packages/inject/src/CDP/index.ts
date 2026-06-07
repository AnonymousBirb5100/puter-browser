import { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";

import { ScramjetClient } from "@mercuryworkshop/scramjet/bundled";
import { ObjectManager } from "./objectmanager";
import { ExecutionContextWrapper } from "../context";
// it's safe to alias box like this, there's only one ever
export let box: InstanceType<typeof ScramjetClient>["box"] = null!;

export function setupCDPServer({ self, rpc, client }: ExecutionContextWrapper) {
	box = client.box;
}

export class CDPSession {
	objects = new ObjectManager(this);
}

export type CdpCommand = keyof ProtocolMapping.Commands;
export type CdpCommandArgs<T extends CdpCommand> =
	ProtocolMapping.Commands[T]["paramsType"] extends []
		? undefined
		: ProtocolMapping.Commands[T]["paramsType"][number];
export type CdpCommandReturn<T extends CdpCommand> =
	ProtocolMapping.Commands[T]["returnType"];

type MaybePromise<T> = T | Promise<T>;
type CdpBinding<T extends CdpCommand> = (
	args: CdpCommandArgs<T>
) => MaybePromise<CdpCommandReturn<T>>;

const cdpBindings: Partial<{
	[T in CdpCommand]: CdpBinding<T>;
}> = {};

export function bindCDP<T extends CdpCommand>(
	method: T,
	binding: CdpBinding<T>
): void {
	(cdpBindings as Record<CdpCommand, unknown>)[method] = binding;
}
