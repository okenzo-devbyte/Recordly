import { spawn } from "node:child_process";
import { ipcMain } from "electron";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";

const WAVEFORM_SAMPLE_RATE = 4_000;
const MIN_WAVEFORM_PEAKS = 64;
const MAX_WAVEFORM_PEAKS = 200_000;
const MAX_STREAM_DURATION_SEC = 4 * 60 * 60; // 4 hours max safety bound

export interface ExtractAudioWaveformPeaksOptions {
	mediaPathOrUrl: string;
	peakCount?: number;
}

export interface ExtractAudioWaveformPeaksResult {
	success: boolean;
	peaks?: Float32Array;
	durationMs?: number;
	error?: string;
}

export function normalizeWaveformPeaks(peaks: Float32Array): Float32Array {
	if (peaks.length === 0) {
		return peaks;
	}

	let max = 0;
	const sortedPeaks = Array.from(peaks).sort((a, b) => a - b);
	const percentileIndex = Math.floor(sortedPeaks.length * 0.995);
	const robustMax = sortedPeaks[percentileIndex] || 0;

	if (robustMax === 0) {
		for (let i = 0; i < peaks.length; i++) {
			if (peaks[i] > max) {
				max = peaks[i];
			}
		}
	} else {
		max = robustMax;
	}

	if (max > 0) {
		for (let i = 0; i < peaks.length; i++) {
			peaks[i] = Math.min(1.0, peaks[i] / max);
		}
	}

	return peaks;
}

export function computeWaveformPeaksFromPcm16(
	pcmBuffer: Buffer,
	requestedPeakCount = 2_000,
	sampleRate = WAVEFORM_SAMPLE_RATE,
): { peaks: Float32Array; durationMs: number } {
	const totalSamples = Math.floor(pcmBuffer.byteLength / 2);
	if (totalSamples <= 0) {
		return {
			peaks: new Float32Array(0),
			durationMs: 0,
		};
	}

	const durationSec = totalSamples / Math.max(1, sampleRate);
	const adaptivePeakCount = Math.max(
		MIN_WAVEFORM_PEAKS,
		Math.floor(requestedPeakCount),
		Math.floor(durationSec * 500),
	);
	const peakCount = Math.min(totalSamples, Math.min(adaptivePeakCount, MAX_WAVEFORM_PEAKS));
	const peaks = new Float32Array(peakCount);

	for (let i = 0; i < peakCount; i++) {
		const startSample = Math.floor((i * totalSamples) / peakCount);
		const endSample = Math.max(
			startSample + 1,
			Math.min(totalSamples, Math.floor(((i + 1) * totalSamples) / peakCount)),
		);
		let maxAbs = 0;
		for (let s = startSample; s < endSample; s++) {
			const sample = pcmBuffer.readInt16LE(s * 2);
			const abs = Math.min(1.0, Math.abs(sample) / 32768);
			if (abs > maxAbs) {
				maxAbs = abs;
			}
		}
		peaks[i] = maxAbs;
	}

	normalizeWaveformPeaks(peaks);

	return {
		peaks,
		durationMs: durationSec * 1000,
	};
}

export async function extractAudioWaveformPeaksFromFile(
	filePath: string,
	requestedPeakCount = 2_000,
): Promise<{ peaks: Float32Array; durationMs: number }> {
	const ffmpegPath = getFfmpegBinaryPath();
	const maxBytes = WAVEFORM_SAMPLE_RATE * 2 * MAX_STREAM_DURATION_SEC;

	const pcmBuffer = await new Promise<Buffer>((resolve, reject) => {
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-threads",
			"1",
			"-i",
			filePath,
			"-vn",
			"-ac",
			"1",
			"-ar",
			String(WAVEFORM_SAMPLE_RATE),
			"-f",
			"s16le",
			"pipe:1",
		];

		const proc = spawn(ffmpegPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let stderrOutput = "";
		let settled = false;

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				// ignore
			}
			reject(new Error("Waveform extraction timed out"));
		}, 60_000);

		proc.stdout.on("data", (chunk: Buffer) => {
			if (settled) return;
			if (totalBytes + chunk.byteLength > maxBytes) {
				const remaining = Math.max(0, maxBytes - totalBytes);
				if (remaining > 0) {
					chunks.push(chunk.subarray(0, remaining));
					totalBytes += remaining;
				}
				settled = true;
				clearTimeout(timeout);
				try {
					proc.kill("SIGKILL");
				} catch {
					// ignore
				}
				resolve(Buffer.concat(chunks, totalBytes));
				return;
			}
			chunks.push(chunk);
			totalBytes += chunk.byteLength;
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			if (stderrOutput.length < 4_096) {
				stderrOutput += chunk.toString();
			}
		});

		proc.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});

		proc.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (code === 0 && totalBytes > 0) {
				resolve(Buffer.concat(chunks, totalBytes));
				return;
			}
			reject(
				new Error(
					stderrOutput.trim() || `FFmpeg waveform extraction exited with code ${code}`,
				),
			);
		});
	});

	return computeWaveformPeaksFromPcm16(pcmBuffer, requestedPeakCount, WAVEFORM_SAMPLE_RATE);
}

export function registerWaveformHandlers() {
	ipcMain.handle(
		"extract-audio-waveform-peaks",
		async (
			_event,
			options: ExtractAudioWaveformPeaksOptions,
		): Promise<ExtractAudioWaveformPeaksResult> => {
			const [{ resolveApprovedLocalMediaPath }, { normalizeVideoSourcePath }] =
				await Promise.all([import("../project/manager"), import("../utils")]);

			try {
				const rawInput = options?.mediaPathOrUrl;
				if (typeof rawInput !== "string" || rawInput.trim().length === 0) {
					return {
						success: false,
						error: "Missing media path",
					};
				}

				const normalizedPath = normalizeVideoSourcePath(rawInput);
				if (!normalizedPath) {
					return {
						success: false,
						error: "Invalid media path",
					};
				}

				const approvedPath = await resolveApprovedLocalMediaPath(normalizedPath);
				if (!approvedPath) {
					return {
						success: false,
						error: "Access denied for media path",
					};
				}

				const peakCount =
					typeof options.peakCount === "number" && Number.isFinite(options.peakCount)
						? Math.max(MIN_WAVEFORM_PEAKS, Math.floor(options.peakCount))
						: 2_000;

				const { peaks, durationMs } = await extractAudioWaveformPeaksFromFile(
					approvedPath,
					peakCount,
				);
				return {
					success: true,
					peaks,
					durationMs,
				};
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	);
}
