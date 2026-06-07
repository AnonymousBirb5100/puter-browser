import { createDelegate, css, type FC } from "dreamland/core";
import { popTab, pushTab } from "../services/TabsService";
import { TabView } from "../Tab/TabView";

let locks: Symbol[] = [];
let setUnfocus = createDelegate<boolean>();
export function requestUnfocusFrames(): [() => void, () => void] {
	let lock = Symbol();
	return [
		() => {
			setUnfocus(true);
			locks.push(lock);
		},
		() => {
			locks = locks.filter((l) => l !== lock);
			if (locks.length === 0) {
				setUnfocus(false);
			}
		},
	];
}

export function Shell(this: FC<{}>) {
	pushTab.listen((tab) => {
		const tabview = <TabView tab={tab} ts={tab.session}></TabView>;
		this.root.appendChild(tabview);
		tab.session.mounted();
	});
	popTab.listen((tab) => {
		const container = this.root.querySelector(`[data-tab="${tab.id}"]`);
		if (!container) throw new Error(`No container found for tab ${tab.id}`);
		container.remove();
	});
	// forceScreenshot.listen(async (tab) => {
	// 	const container = this.root.querySelector(
	// 		`[data-tab="${tab.id}"]`
	// 	) as HTMLElement;
	// 	if (!container) throw new Error(`No container found for tab ${tab.id}`);

	// 	let blob = await takeScreenshotGDM(container);
	// 	if (blob) tab.screenshot = URL.createObjectURL(blob);
	// 	else {
	// 		// tab.screenshot = await takeScreenshotSvg(container);
	// 	}
	// });
	setUnfocus.listen((unfocus) => {
		if (unfocus) {
			this.root
				.querySelectorAll(".mainframecontainer, .devtoolsframecontainer")
				.forEach((el) => {
					if (!(el instanceof HTMLElement)) return;
					el.style.pointerEvents = "none";
				});
		} else {
			this.root
				.querySelectorAll(".mainframecontainer, .devtoolsframecontainer")
				.forEach((el) => {
					if (!(el instanceof HTMLElement)) return;
					el.style.pointerEvents = "";
				});
		}
	});

	return <div></div>;
}

Shell.style = css`
	:scope {
		flex: 1;
		overflow: hidden;
		width: 100%;
		position: relative;
	}
`;
