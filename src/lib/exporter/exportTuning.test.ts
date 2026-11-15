import { describe, expect, it } from "vitest";

import {
	getExportBackpressureProfile,
	getPreferredWebCodecsLatencyModes,
	getWebCodecsEncodeQueueLimit,
	getWebCodecsKeyFrameInterval,
} from "./exportTuning";

describe("exportTuning", () => {
	it("prefers realtime latency for fast and balanced exports", () => {
		expect(getPreferredWebCodecsLatencyModes("fast")).toEqual(["realtime", "quality"]);
		expect(getPreferredWebCodecsLatencyModes("balanced")).toEqual(["realtime", "quality"]);
		expect(getPreferredWebCodecsLatencyModes("quality")).toEqual(["quality", "realtime"]);
	});

	it("keeps queue depth bounded by encoding mode", () => {
		expect(getWebCodecsEncodeQueueLimit(60, "fast")).toBe(75);
		expect(getWebCodecsEncodeQueueLimit(60, "balanced")).toBe(120);
		expect(getWebCodecsEncodeQueueLimit(60, "quality")).toBe(144);
		expect(getWebCodecsEncodeQueueLimit(240, "fast")).toBe(96);
		expect(getWebCodecsEncodeQueueLimit(12, "balanced")).toBe(72);
	});

	it("widens keyframe spacing for faster modes", () => {
		expect(getWebCodecsKeyFrameInterval(60, "fast")).toBe(240);
		expect(getWebCodecsKeyFrameInterval(60, "balanced")).toBe(180);
		expect(getWebCodecsKeyFrameInterval(60, "quality")).toBe(150);
	});

	it("uses shallower decode buffers for Breeze than for WebCodecs", () => {
		const webCodecsProfile = getExportBackpressureProfile({
			encodeBackend: "webcodecs",
			width: 1280,
			height: 720,
			frameRate: 60,
			encodingMode: "balanced",
			hardwareConcurrency: 8,
		});
		const breezeProfile = getExportBackpressureProfile({
			encodeBackend: "ffmpeg",
			width: 1280,
			height: 720,
			frameRate: 60,
			encodingMode: "balanced",
			hardwareConcurrency: 8,
		});

		expect(webCodecsProfile.name).toBe("webcodecs-balanced-plus");
		expect(webCodecsProfile.maxDecodeQueue).toBe(12);
		expect(webCodecsProfile.maxPendingFrames).toBe(32);
		expect(breezeProfile.name).toBe("breeze-balanced-plus");
		expect(breezeProfile.maxDecodeQueue).toBe(14);
		expect(breezeProfile.maxPendingFrames).toBe(40);
		expect(breezeProfile.maxInFlightNativeWrites).toBe(8);
	});

	it("falls back to conservative native settings on low-core or very heavy workloads", () => {
		const breezeLowCoreProfile = getExportBackpressureProfile({
			encodeBackend: "ffmpeg",
			width: 1280,
			height: 720,
			frameRate: 60,
			hardwareConcurrency: 4,
		});
		const breezeHeavyProfile = getExportBackpressureProfile({
			encodeBackend: "ffmpeg",
			width: 3840,
			height: 2160,
			frameRate: 60,
			hardwareConcurrency: 12,
		});

		expect(breezeLowCoreProfile.name).toBe("breeze-conservative");
		expect(breezeLowCoreProfile.maxDecodeQueue).toBe(8);
		expect(breezeLowCoreProfile.maxPendingFrames).toBe(16);
		expect(breezeLowCoreProfile.maxInFlightNativeWrites).toBe(2);

		expect(breezeHeavyProfile.name).toBe("breeze-conservative");
		expect(breezeHeavyProfile.maxDecodeQueue).toBe(8);
		expect(breezeHeavyProfile.maxPendingFrames).toBe(16);
	});

	it("selects low-memory profiles on <= 8 GB RAM machines unless disabled", () => {
		const breezeLowMem = getExportBackpressureProfile({
			encodeBackend: "ffmpeg",
			width: 1920,
			height: 1080,
			frameRate: 60,
			encodingMode: "balanced",
			hardwareConcurrency: 8,
			deviceMemoryGb: 8,
		});
		const webCodecsLowMem = getExportBackpressureProfile({
			encodeBackend: "webcodecs",
			width: 1920,
			height: 1080,
			frameRate: 60,
			encodingMode: "balanced",
			hardwareConcurrency: 6,
			deviceMemoryGb: 4,
		});
		const highPerfOverride = getExportBackpressureProfile({
			encodeBackend: "ffmpeg",
			width: 1280,
			height: 720,
			frameRate: 60,
			encodingMode: "balanced",
			hardwareConcurrency: 8,
			deviceMemoryGb: 8,
			allowLowMemoryProfile: false,
		});

		expect(breezeLowMem).toEqual({
			name: "breeze-low-memory",
			maxEncodeQueue: 24,
			maxDecodeQueue: 4,
			maxPendingFrames: 6,
			maxInFlightNativeWrites: 2,
		});
		expect(webCodecsLowMem).toEqual({
			name: "webcodecs-low-memory",
			maxEncodeQueue: 24,
			maxDecodeQueue: 4,
			maxPendingFrames: 8,
			maxInFlightNativeWrites: 1,
		});
		expect(highPerfOverride.name).toBe("breeze-balanced-plus");
	});
});
