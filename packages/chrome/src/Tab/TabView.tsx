import { css, type FC } from "dreamland/core";
import type { Tab } from "./Tab";
import { requestUnfocusFrames } from "@components/Shell";
import { tabsService } from "..";
import type { TabSession } from "./TabSession";

export function TabView(this: FC<{ tab: Tab; ts: TabSession }>) {
	const [lock, unlock] = requestUnfocusFrames();

	let mouseMoveListen = (e: MouseEvent) => {
		this.tab.devtoolsWidth = window.innerWidth - e.clientX;
	};

	this.ts.frame.classList.add(this.cx.id!);
	this.ts.devtoolsFrame.classList.add(this.cx.id!);

	return (
		<div
			class="container"
			data-tab={this.tab.id}
			id={"tab" + this.tab.id}
			class:active={use(tabsService.activetab).map((t) => t === this.tab)}
			class:showframe={use(this.tab.internalpage).map((t) => !t)}
		>
			<div class="mainframecontainer">
				{use(this.tab.internalpage)}
				{this.ts.frame}
			</div>
			<div
				class="devtools"
				class:active={use(this.tab.devtoolsOpen)}
				style={use`width: ${this.tab.devtoolsWidth}px`}
			>
				<div
					on:mousedown={(e: MouseEvent) => {
						lock();
						document.body.style.cursor = "ew-resize";
						window.addEventListener("mousemove", mouseMoveListen);
						window.addEventListener("mouseup", () => {
							unlock();
							window.removeEventListener("mousemove", mouseMoveListen);
							document.body.style.cursor = "";
						});
					}}
					class="divider"
				></div>
				<div class="devtoolsframecontainer">{this.ts.devtoolsFrame}</div>
			</div>
			<progress value={use(this.tab.loadProgress)}></progress>
		</div>
	);
}
TabView.style = css`
	:scope {
		position: absolute;
		width: 100%;
		height: 100%;
		display: flex;
		top: 0;
		left: 0;
		z-index: -1;
		/*display: none;*/

		/*https://screen-share.github.io/element-capture/#elements-eligible-for-restriction*/
		isolation: isolate;
		transform-style: flat;

		background-color: var(--ntp_background);
	}
	:scope.active {
		z-index: 0;
	}
	.devtools {
		position: relative;
		display: none;
		width: 20em;
	}
	.devtools.active {
		display: flex;
	}

	.devtoolsframecontainer {
		width: 100%;
	}

	.mainframecontainer {
		display: flex;
		width: 100%;
		flex: 1;
		background: white;
	}

	.divider {
		position: absolute;
		top: 0;
		left: -5px;
		width: 5px;
		/* background: #ccc; */
		border-right: 1px solid #ccc;
		height: 100%;
		cursor: ew-resize;
	}

	iframe {
		flex: 1;
		height: 100%;
		width: 100%;
		border: none;
		display: none;
	}
	.showframe iframe {
		display: block;
	}
	progress {
		z-index: 1;
		position: absolute;
		width: 100%;
		height: 3px;
		border: none;
	}
	progress::-webkit-progress-bar {
		background-color: transparent;
	}
	progress::-webkit-progress-value {
		background-color: var(--tab_line);
	}
`;
