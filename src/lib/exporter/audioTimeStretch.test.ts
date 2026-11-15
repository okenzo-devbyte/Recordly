import { describe, expect, it, vi } from "vitest";
import { stretchChannelDataWsola } from "./audioTimeStretch";
import { captureRawvideoFrame } from "./modernNativeStreamFrames";
import { ModernNativeResources } from "./modernNativeResources";

describe("stretchChannelDataWsola", () => {
	it("copies samples unchanged when speed is 1x", () => {
		const input = new Float32Array(4_000);
		for (let i = 0; i < input.length; i++) {
			input[i] = Math.sin((2 * Math.PI * 440 * i) / 4_000);
		}

		const out = stretchChannelDataWsola({
			inputChannels: [input],
			sampleRate: 4_000,
			speed: 1,
			sourceOffsetSec: 0,
			sourceDurationSec: 0.5,
			audibleDurationSec: 0.5,
		});

		expect(out).toHaveLength(1);
		expect(out[0]).toHaveLength(2_000);
		expect(out[0][100]).toBeCloseTo(input[100], 5);
	});

	it("produces pitch-preserved time-stretched output for 2x and 0.5x speeds", () => {
		const sampleRate = 8_000;
		const input = new Float32Array(sampleRate); // 1 second
		for (let i = 0; i < input.length; i++) {
			input[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate);
		}

		const fast = stretchChannelDataWsola({
			inputChannels: [input],
			sampleRate,
			speed: 2,
			sourceOffsetSec: 0,
			sourceDurationSec: 1.0,
			audibleDurationSec: 0.5,
		});
		expect(fast[0]).toHaveLength(4_000);

		const slow = stretchChannelDataWsola({
			inputChannels: [input],
			sampleRate,
			speed: 0.5,
			sourceOffsetSec: 0,
			sourceDurationSec: 0.5,
			audibleDurationSec: 1.0,
		});
		expect(slow[0]).toHaveLength(8_000);
	});
});

describe("captureRawvideoFrame pooled readback & WebGL direct readPixels", () => {
	it("reuses pooled readback buffers and uses renderer.captureBottomUpPixelsInto when available", () => {
		const nativeResources = new ModernNativeResources({
			videoUrl: "file:///video.mp4",
			width: 4,
			height: 2,
			frameRate: 30,
			bitrate: 1_000_000,
		});
		nativeResources.nativeInputMode = "rawvideo";

		const captureBottomUpPixelsInto = vi.fn((target: Uint8Array) => {
			target.fill(128);
			return true;
		});

		const session = {
			config: { width: 4, height: 2 },
			native: nativeResources,
			browser: {
				renderer: {
					getCanvas: () => ({ width: 4, height: 2 }) as HTMLCanvasElement,
					captureBottomUpPixelsInto,
				},
			},
			cancelled: false,
			flow: {},
			metrics: {},
		};

		const firstBuffer = captureRawvideoFrame(session as never, {} as never);
		expect(captureBottomUpPixelsInto).toHaveBeenCalledTimes(1);
		expect(firstBuffer.byteLength).toBe(4 * 2 * 4);
		expect(firstBuffer[0]).toBe(128);

		nativeResources.releaseReadbackBuffer(firstBuffer);
		expect(nativeResources.nativeReadbackBufferPool).toHaveLength(1);

		const secondBuffer = captureRawvideoFrame(session as never, {} as never);
		expect(secondBuffer).toBe(firstBuffer);
		expect(nativeResources.nativeReadbackBufferPool).toHaveLength(0);
	});
});
