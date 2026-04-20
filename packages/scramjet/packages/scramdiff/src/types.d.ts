/**
 * Ambient module declarations for dependencies without shipped types.
 */

declare module "@mercuryworkshop/wisp-js/server" {
	export const server: {
		options: {
			allow_private_ips: boolean;
			allow_loopback_ips: boolean;
			[k: string]: unknown;
		};
		routeRequest(req: unknown, socket: unknown, head: unknown): void;
	};
	export const logging: {
		NONE: number;
		set_level(level: number): void;
	};
}
