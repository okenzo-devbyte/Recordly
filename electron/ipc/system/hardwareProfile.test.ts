import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getExportHardwareInfoMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
	app: {
		getPath: () => "/unused",
	},
}));

vi.mock("../export/nativeVideo/hardware", () => ({
	getExportHardwareInfo: getExportHardwareInfoMock,
}));

vi.mock("../constants", () => ({
	RECORDINGS_SETTINGS_FILE: "/unused/recordings-settings.json",
}));

import {
	buildSystemHardwareProfile,
	getMainPerformanceBudget,
	getSystemHardwareProfile,
	inferHasHardwareEncoder,
	resetCachedHardwareProfileForTest,
} from "./hardwareProfile";

describe("system hardwareProfile", () => {
	beforeEach(() => {
		resetCachedHardwareProfileForTest();
		getExportHardwareInfoMock.mockReset();
	});

	afterEach(() => {
		resetCachedHardwareProfileForTest();
	});

	it("detects software-only renderers as lacking hardware encoding", () => {
		expect(
			inferHasHardwareEncoder({
				platform: "win32",
				gpuFeatures: { videoEncode: "disabled_off" },
				gpus: [{ name: "Microsoft Basic Render Driver", vendor: null }],
			}),
		).toBe(false);
		expect(
			inferHasHardwareEncoder({
				platform: "win32",
				gpuFeatures: { videoEncode: "enabled" },
				gpus: [{ name: "NVIDIA GeForce RTX 3060", vendor: "NVIDIA" }],
			}),
		).toBe(true);
	});

	it("classifies a 4-core 8 GB Windows laptop as low-spec", () => {
		const profile = buildSystemHardwareProfile({
			platform: "win32",
			logicalProcessors: 4,
			totalMemoryGb: 8,
			gpuFeatures: { videoEncode: "enabled" },
			gpus: [{ name: "Intel UHD Graphics", vendor: "Intel" }],
		});
		expect(profile.recommendedTier).toBe("low");
		expect(profile.hasHardwareEncoder).toBe(true);
	});

	it("caches detected hardware profile across calls unless refresh is requested", async () => {
		getExportHardwareInfoMock.mockResolvedValue({
			platform: "win32",
			release: "10.0.22631",
			arch: "x64",
			cpuModel: "Core i5",
			logicalProcessors: 8,
			totalMemoryGb: 16,
			machineModel: null,
			gpus: [{ name: "NVIDIA GeForce GTX 1660", vendor: "NVIDIA", active: true }],
			gpuFeatures: {
				videoDecode: "enabled",
				videoEncode: "enabled",
				webgl: "enabled",
				webgpu: "enabled",
			},
		});

		const first = await getSystemHardwareProfile();
		const second = await getSystemHardwareProfile();
		expect(first.recommendedTier).toBe("balanced");
		expect(second).toBe(first);
		expect(getExportHardwareInfoMock).toHaveBeenCalledTimes(1);

		await getSystemHardwareProfile({ refresh: true });
		expect(getExportHardwareInfoMock).toHaveBeenCalledTimes(2);
	});

	it("resolves main performance budget using detected hardware when preferences are unset", async () => {
		getExportHardwareInfoMock.mockResolvedValue({
			platform: "win32",
			release: "10.0.22631",
			arch: "x64",
			cpuModel: "Core i3",
			logicalProcessors: 4,
			totalMemoryGb: 8,
			machineModel: null,
			gpus: [{ name: "Intel UHD Graphics", vendor: "Intel", active: true }],
			gpuFeatures: {
				videoDecode: "enabled",
				videoEncode: "enabled",
				webgl: "enabled",
				webgpu: "enabled",
			},
		});

		const budget = await getMainPerformanceBudget({ refreshHardware: true });
		expect(budget.tier).toBe("low");
		expect(budget.recording.fps).toBe(30);
		expect(budget.recording.maxWidth).toBe(1920);
	});
});
