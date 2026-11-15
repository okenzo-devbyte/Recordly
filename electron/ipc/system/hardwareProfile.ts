import os from "node:os";
import {
	classifyHardwareTier,
	DEFAULT_PERFORMANCE_PREFERENCES,
	normalizePerformancePreferences,
	type PerformanceBudget,
	type PerformancePreferences,
	resolvePerformanceBudget,
	type SystemHardwareProfile,
} from "../../../src/shared/performanceProfile";
import { RECORDINGS_SETTINGS_FILE } from "../constants";
import { getExportHardwareInfo } from "../export/nativeVideo/hardware";
import { createRecordingPreferencesStore } from "../settings/recordingPreferencesStore";

let cachedHardwareProfile: SystemHardwareProfile | null = null;
let pendingHardwareProfilePromise: Promise<SystemHardwareProfile> | null = null;

export function inferHasHardwareEncoder(input: {
	platform: string;
	gpuFeatures?: { videoEncode?: string | null };
	gpus?: Array<{ name?: string | null; vendor?: string | null; active?: boolean | null }>;
}): boolean {
	const encodeStatus = input.gpuFeatures?.videoEncode?.trim().toLowerCase() ?? "";
	if (encodeStatus.startsWith("enabled")) {
		return true;
	}
	if (encodeStatus.startsWith("disabled") || encodeStatus.startsWith("unavailable")) {
		return false;
	}

	const gpus = input.gpus ?? [];
	const hasKnownGpuVendor = gpus.some((gpu) => {
		const vendor = gpu.vendor?.toLowerCase() ?? "";
		const name = gpu.name?.toLowerCase() ?? "";
		if (name.includes("basic render") || name.includes("llvmpipe") || name.includes("swiftshader")) {
			return false;
		}
		return (
			vendor === "nvidia" ||
			vendor === "amd" ||
			vendor === "intel" ||
			vendor === "apple" ||
			/\b(nvidia|geforce|quadro|rtx|gtx|radeon|rx\s?\d|arc|iris|uhd|apple)\b/i.test(name)
		);
	});

	if (input.platform === "darwin" && gpus.length > 0) {
		return true;
	}

	return hasKnownGpuVendor;
}

export function buildSystemHardwareProfile(input: {
	platform: string;
	logicalProcessors: number;
	totalMemoryGb: number;
	gpuFeatures?: { videoEncode?: string | null };
	gpus?: Array<{ name?: string | null; vendor?: string | null; active?: boolean | null }>;
}): SystemHardwareProfile {
	const logicalProcessors = Math.max(1, Math.round(input.logicalProcessors || 1));
	const totalMemoryGb = Math.max(0, Math.round((input.totalMemoryGb || 0) * 10) / 10);
	const hasHardwareEncoder = inferHasHardwareEncoder(input);
	const recommendedTier = classifyHardwareTier({
		logicalProcessors,
		totalMemoryGb,
		hasHardwareEncoder,
	});
	const gpuNames = (input.gpus ?? [])
		.map((gpu) => gpu.name?.trim())
		.filter((name): name is string => Boolean(name));

	return {
		platform: input.platform,
		logicalProcessors,
		totalMemoryGb,
		hasHardwareEncoder,
		recommendedTier,
		...(gpuNames.length > 0 ? { gpuNames } : {}),
	};
}

export async function getSystemHardwareProfile(options?: {
	refresh?: boolean;
}): Promise<SystemHardwareProfile> {
	if (cachedHardwareProfile && !options?.refresh) {
		return cachedHardwareProfile;
	}
	if (pendingHardwareProfilePromise && !options?.refresh) {
		return pendingHardwareProfilePromise;
	}

	pendingHardwareProfilePromise = (async () => {
		try {
			const info = await getExportHardwareInfo();
			const profile = buildSystemHardwareProfile({
				platform: info.platform,
				logicalProcessors: info.logicalProcessors,
				totalMemoryGb: info.totalMemoryGb,
				gpuFeatures: info.gpuFeatures,
				gpus: info.gpus,
			});
			cachedHardwareProfile = profile;
			return profile;
		} catch {
			const logicalProcessors = os.cpus().length || 4;
			const totalMemoryGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
			const fallback = buildSystemHardwareProfile({
				platform: process.platform,
				logicalProcessors,
				totalMemoryGb,
			});
			cachedHardwareProfile = fallback;
			return fallback;
		} finally {
			pendingHardwareProfilePromise = null;
		}
	})();

	return pendingHardwareProfilePromise;
}

export function resetCachedHardwareProfileForTest() {
	cachedHardwareProfile = null;
	pendingHardwareProfilePromise = null;
}

const performancePreferencesStore = createRecordingPreferencesStore(RECORDINGS_SETTINGS_FILE);

export async function readPerformancePreferencesFromDisk(): Promise<PerformancePreferences> {
	try {
		const raw = await performancePreferencesStore.read();
		return normalizePerformancePreferences(raw);
	} catch {
		return { ...DEFAULT_PERFORMANCE_PREFERENCES };
	}
}

export async function getMainPerformanceBudget(options?: {
	refreshHardware?: boolean;
}): Promise<PerformanceBudget> {
	const [preferences, hardware] = await Promise.all([
		readPerformancePreferencesFromDisk(),
		getSystemHardwareProfile({ refresh: options?.refreshHardware }),
	]);
	return resolvePerformanceBudget(preferences, hardware);
}
