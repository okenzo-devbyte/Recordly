import { Container, Sprite, Texture } from "pixi.js";
import { drawSquircleOnCanvas } from "@/lib/geometry/squircle";
import {
	getShadowFilterPadding,
	getVideoShadowStrength,
	type ShadowLayerProfile,
	VIDEO_SHADOW_LAYER_PROFILES,
} from "@/lib/exporter/shadowProfile";
import { getSceneEffectMetrics } from "./sceneEffects";

export interface PreviewShadowLayoutOptions {
	enabled: boolean;
	stageWidth: number;
	maskX: number;
	maskY: number;
	maskWidth: number;
	maskHeight: number;
	maskRadius: number;
	shadowIntensity: number;
}

type ShadowLayerRecord = {
	profile: ShadowLayerProfile;
	container: Container;
	sprite: Sprite | null;
	canvas: HTMLCanvasElement | null;
	context: CanvasRenderingContext2D | null;
};

export interface PreviewShadowController {
	readonly container: Container;
	attach: (cameraContainer: Container) => void;
	updateLayout: (options: PreviewShadowLayoutOptions) => boolean;
	destroy: () => void;
}

export function createPreviewShadowController(
	createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
): PreviewShadowController {
	const shadowContainer = new Container();
	shadowContainer.visible = false;

	const layers: ShadowLayerRecord[] = VIDEO_SHADOW_LAYER_PROFILES.map((profile) => {
		const layerContainer = new Container();
		layerContainer.visible = false;
		shadowContainer.addChild(layerContainer);
		return {
			profile,
			container: layerContainer,
			sprite: null,
			canvas: null,
			context: null,
		};
	});

	let lastLayoutKey: string | null = null;
	let destroyed = false;

	const hide = () => {
		shadowContainer.visible = false;
		for (const layer of layers) {
			layer.container.visible = false;
		}
		lastLayoutKey = "hidden";
	};

	const ensureLayerCanvas = (layer: ShadowLayerRecord, width: number, height: number) => {
		const targetWidth = Math.max(1, Math.ceil(width));
		const targetHeight = Math.max(1, Math.ceil(height));

		if (
			layer.canvas &&
			layer.canvas.width === targetWidth &&
			layer.canvas.height === targetHeight &&
			layer.context &&
			layer.sprite
		) {
			return;
		}

		const canvas = createCanvas();
		canvas.width = targetWidth;
		canvas.height = targetHeight;
		const context = canvas.getContext("2d");
		if (!context) {
			layer.canvas = null;
			layer.context = null;
			return;
		}

		layer.canvas = canvas;
		layer.context = context;

		const nextTexture = Texture.from(canvas);
		if (layer.sprite) {
			const previousTexture = layer.sprite.texture;
			layer.sprite.texture = nextTexture;
			previousTexture?.destroy?.(true);
		} else {
			layer.sprite = new Sprite(nextTexture);
			layer.container.addChild(layer.sprite);
		}
	};

	return {
		container: shadowContainer,
		attach: (cameraContainer: Container) => {
			if (destroyed) return;
			if (shadowContainer.parent !== cameraContainer) {
				cameraContainer.addChildAt(shadowContainer, 0);
			}
		},
		updateLayout: (options: PreviewShadowLayoutOptions): boolean => {
			if (destroyed) return false;
			const shadowStrength = getVideoShadowStrength(options.shadowIntensity);
			if (
				!options.enabled ||
				shadowStrength <= 0 ||
				options.stageWidth <= 0 ||
				options.maskWidth <= 0 ||
				options.maskHeight <= 0
			) {
				if (lastLayoutKey === "hidden") {
					return false;
				}
				hide();
				return true;
			}

			const nextKey = [
				Math.round(options.stageWidth * 10),
				Math.round(options.maskX * 10),
				Math.round(options.maskY * 10),
				Math.round(options.maskWidth * 10),
				Math.round(options.maskHeight * 10),
				Math.round(options.maskRadius * 10),
				shadowStrength.toFixed(4),
			].join(":");

			if (nextKey === lastLayoutKey) {
				return false;
			}

			const effectScale = getSceneEffectMetrics({
				viewportWidth: options.stageWidth,
				backgroundBlur: 0,
				shadowIntensity: shadowStrength,
			}).viewportScale;

			let drewAnyLayer = false;
			for (const layer of layers) {
				const offsetY = layer.profile.offsetScale * effectScale * shadowStrength;
				const blur = Math.max(0, layer.profile.blurScale * effectScale * shadowStrength);
				const alpha = layer.profile.alphaScale * shadowStrength;
				if (alpha <= 0) {
					layer.container.visible = false;
					continue;
				}

				const padding = getShadowFilterPadding(blur, offsetY);
				// Soft ambient shadows rasterize cleanly at half resolution and save 75% canvas memory.
				const rasterScale = layer.profile.blurScale > 8 ? 0.5 : 1;
				ensureLayerCanvas(
					layer,
					(options.maskWidth + padding * 2) * rasterScale,
					(options.maskHeight + padding * 2) * rasterScale,
				);

				if (!layer.canvas || !layer.context || !layer.sprite) {
					layer.container.visible = false;
					continue;
				}

				const ctx = layer.context;
				ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
				ctx.save();
				ctx.scale(rasterScale, rasterScale);
				ctx.filter = blur > 0 ? `blur(${blur}px)` : "none";
				ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
				drawSquircleOnCanvas(ctx, {
					x: padding,
					y: padding + offsetY,
					width: options.maskWidth,
					height: options.maskHeight,
					radius: options.maskRadius,
				});
				ctx.fill();
				ctx.restore();

				layer.sprite.scale.set(1 / rasterScale);
				layer.sprite.position.set(options.maskX - padding, options.maskY - padding);
				layer.sprite.texture?.source?.update?.();
				layer.container.alpha = 1;
				layer.container.visible = true;
				drewAnyLayer = true;
			}

			shadowContainer.visible = drewAnyLayer;
			lastLayoutKey = nextKey;
			return true;
		},
		destroy: () => {
			if (destroyed) return;
			destroyed = true;
			for (const layer of layers) {
				if (layer.sprite) {
					const texture = layer.sprite.texture;
					layer.sprite.destroy?.();
					texture?.destroy?.(true);
					layer.sprite = null;
				}
				layer.canvas = null;
				layer.context = null;
			}
			shadowContainer.parent?.removeChild?.(shadowContainer);
			shadowContainer.destroy?.({ children: true });
			lastLayoutKey = null;
		},
	};
}
