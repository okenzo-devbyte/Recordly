import { describe, expect, it, vi } from "vitest";

vi.mock("pixi.js", () => {
	class MockContainer {
		visible = true;
		alpha = 1;
		parent: MockContainer | null = null;
		children: unknown[] = [];
		addChild(child: unknown) {
			this.children.push(child);
			if (child && typeof child === "object") {
				(child as { parent?: unknown }).parent = this;
			}
			return child;
		}
		addChildAt(child: unknown, index: number) {
			this.children.splice(index, 0, child);
			if (child && typeof child === "object") {
				(child as { parent?: unknown }).parent = this;
			}
			return child;
		}
		removeChild(child: unknown) {
			const idx = this.children.indexOf(child);
			if (idx >= 0) this.children.splice(idx, 1);
			return child;
		}
		destroy() {
			this.children = [];
		}
	}

	class MockSprite {
		texture: { source?: { update?: () => void }; destroy?: (destroySource?: boolean) => void };
		scale = {
			x: 1,
			y: 1,
			set: (x: number, y = x) => {
				this.scale.x = x;
				this.scale.y = y;
			},
		};
		position = {
			x: 0,
			y: 0,
			set: (x: number, y: number) => {
				this.position.x = x;
				this.position.y = y;
			},
		};
		constructor(texture: {
			source?: { update?: () => void };
			destroy?: (destroySource?: boolean) => void;
		}) {
			this.texture = texture;
		}
		destroy() {}
	}

	return {
		Container: MockContainer,
		Sprite: MockSprite,
		Texture: {
			from: vi.fn((canvas: unknown) => ({
				canvas,
				source: { update: vi.fn() },
				destroy: vi.fn(),
			})),
		},
	};
});

import { Container } from "pixi.js";
import { createPreviewShadowController } from "./previewShadows";

function createFakeCanvasFactory() {
	const contexts: Array<{
		clearRect: ReturnType<typeof vi.fn>;
		fill: ReturnType<typeof vi.fn>;
		scale: ReturnType<typeof vi.fn>;
		save: ReturnType<typeof vi.fn>;
		restore: ReturnType<typeof vi.fn>;
	}> = [];
	const createCanvas = () => {
		const ctx = {
			filter: "none",
			fillStyle: "",
			clearRect: vi.fn(),
			save: vi.fn(),
			restore: vi.fn(),
			scale: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			bezierCurveTo: vi.fn(),
			closePath: vi.fn(),
			fill: vi.fn(),
		};
		contexts.push(ctx);
		return {
			width: 0,
			height: 0,
			getContext: () => ctx,
		} as unknown as HTMLCanvasElement;
	};
	return { createCanvas, contexts };
}

describe("createPreviewShadowController", () => {
	it("attaches behind video effects container and caches identical layouts", () => {
		const { createCanvas, contexts } = createFakeCanvasFactory();
		const controller = createPreviewShadowController(createCanvas);
		const cameraContainer = new Container();
		const videoEffectsContainer = new Container();
		cameraContainer.addChild(videoEffectsContainer);
		controller.attach(cameraContainer);

		expect(cameraContainer.children[0]).toBe(controller.container);
		expect(cameraContainer.children[1]).toBe(videoEffectsContainer);

		const layout = {
			enabled: true,
			stageWidth: 800,
			maskX: 40,
			maskY: 30,
			maskWidth: 720,
			maskHeight: 405,
			maskRadius: 12,
			shadowIntensity: 0.5,
		};

		expect(controller.updateLayout(layout)).toBe(true);
		expect(controller.container.visible).toBe(true);
		expect(contexts).toHaveLength(2);
		expect(contexts[0].fill).toHaveBeenCalledTimes(1);
		expect(contexts[1].fill).toHaveBeenCalledTimes(1);

		// Identical layout does not re-rasterize
		expect(controller.updateLayout(layout)).toBe(false);
		expect(contexts[0].fill).toHaveBeenCalledTimes(1);
		expect(contexts[1].fill).toHaveBeenCalledTimes(1);

		// Disabling hides container cleanly
		expect(controller.updateLayout({ ...layout, enabled: false })).toBe(true);
		expect(controller.container.visible).toBe(false);
		expect(controller.updateLayout({ ...layout, enabled: false })).toBe(false);

		controller.destroy();
		expect(cameraContainer.children).toEqual([videoEffectsContainer]);
	});
});
