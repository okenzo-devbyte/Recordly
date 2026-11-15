import { describe, expect, it } from "vitest";
import { computeWaveformPeaksFromPcm16, normalizeWaveformPeaks } from "./waveform";

describe("audio waveform peak extraction", () => {
	it("computes normalized peak buckets and duration from s16le PCM samples", () => {
		const sampleRate = 4_000;
		const totalSamples = 4_000; // 1 second
		const pcm = Buffer.alloc(totalSamples * 2);

		// First half quiet (quarter amplitude), second half loud (half amplitude)
		for (let i = 0; i < totalSamples; i++) {
			const value = i < totalSamples / 2 ? 8_192 : 16_384;
			pcm.writeInt16LE(value, i * 2);
		}

		const result = computeWaveformPeaksFromPcm16(pcm, 100, sampleRate);
		expect(result.durationMs).toBe(1_000);
		expect(result.peaks.length).toBe(500); // adaptive min floor for 1s is 500
		expect(result.peaks[0]).toBeCloseTo(0.5, 2);
		expect(result.peaks[result.peaks.length - 1]).toBeCloseTo(1.0, 2);
	});

	it("returns empty peaks and zero duration for an empty PCM buffer", () => {
		const result = computeWaveformPeaksFromPcm16(Buffer.alloc(0), 100, 4_000);
		expect(result.durationMs).toBe(0);
		expect(result.peaks.length).toBe(0);
	});

	it("normalizes using 99.5th percentile so a single outlier spike does not crush the waveform", () => {
		const peaks = new Float32Array(1_000);
		peaks.fill(0.25);
		peaks[999] = 1.0; // Single 0.1% pop
		normalizeWaveformPeaks(peaks);

		expect(peaks[0]).toBeCloseTo(1.0, 3);
		expect(peaks[999]).toBeCloseTo(1.0, 3);
	});
});
