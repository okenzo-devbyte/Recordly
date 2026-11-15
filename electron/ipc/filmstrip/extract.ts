import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";

const execFileAsync = promisify(execFile);

const MAX_TIMESTAMPS_PER_BATCH = 32;
const DEFAULT_THUMBNAIL_WIDTH = 160;
const DEFAULT_THUMBNAIL_HEIGHT = 90;

let extractionQueue: Promise<unknown> = Promise.resolve();

export interface ExtractFilmstripFramesOptions {
	videoPathOrUrl: string;
	timesMs: number[];
	width?: number;
	height?: number;
}

export interface ExtractFilmstripFrameItem {
	timeMs: number;
	jpegData: Uint8Array;
}

export interface ExtractFilmstripFramesResult {
	success: boolean;
	frames?: ExtractFilmstripFrameItem[];
	error?: string;
}

export function buildFilmstripFrameFfmpegArgs(options: {
	inputPath: string;
	timeMs: number;
	width?: number;
	height?: number;
}): string[] {
	const width = Math.max(32, Math.min(640, Math.round(options.width ?? DEFAULT_THUMBNAIL_WIDTH)));
	const height = Math.max(
		18,
		Math.min(360, Math.round(options.height ?? DEFAULT_THUMBNAIL_HEIGHT)),
	);
	const seekSeconds = Math.max(0, options.timeMs / 1000).toFixed(3);

	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-threads",
		"1",
		"-ss",
		seekSeconds,
		"-i",
		options.inputPath,
		"-frames:v",
		"1",
		"-vf",
		`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
		"-q:v",
		"6",
		"-f",
		"image2pipe",
		"-vcodec",
		"mjpeg",
		"pipe:1",
	];
}

export async function extractFilmstripFrameJpeg(options: {
	ffmpegPath: string;
	inputPath: string;
	timeMs: number;
	width?: number;
	height?: number;
}): Promise<Uint8Array | null> {
	const args = buildFilmstripFrameFfmpegArgs(options);
	const { stdout } = await execFileAsync(options.ffmpegPath, args, {
		encoding: "buffer",
		maxBuffer: 4 * 1024 * 1024,
		timeout: 8_000,
	});
	if (!stdout || stdout.byteLength === 0) {
		return null;
	}
	return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength);
}

export function registerFilmstripHandlers() {
	ipcMain.handle(
		"extract-filmstrip-frames",
		async (
			event,
			options: ExtractFilmstripFramesOptions,
		): Promise<ExtractFilmstripFramesResult> => {
			const [{ resolveApprovedLocalMediaPath }, { normalizeVideoSourcePath }] =
				await Promise.all([import("../project/manager"), import("../utils")]);

			try {
				const rawInput = options?.videoPathOrUrl;
				if (typeof rawInput !== "string" || rawInput.trim().length === 0) {
					return {
						success: false,
						error: "Missing video path",
					};
				}

				const normalizedPath = normalizeVideoSourcePath(rawInput);
				if (!normalizedPath) {
					return {
						success: false,
						error: "Invalid video path",
					};
				}

				const approvedPath = await resolveApprovedLocalMediaPath(normalizedPath);
				if (!approvedPath) {
					return {
						success: false,
						error: "Access denied for video path",
					};
				}

				const rawTimes = Array.isArray(options?.timesMs) ? options.timesMs : [];
				const sanitizedTimes = rawTimes
					.filter((t): t is number => typeof t === "number" && Number.isFinite(t))
					.slice(0, MAX_TIMESTAMPS_PER_BATCH)
					.map((t) => Math.max(0, Math.round(t)));

				if (sanitizedTimes.length === 0) {
					return {
						success: true,
						frames: [],
					};
				}

				const ffmpegPath = getFfmpegBinaryPath();
				const job = extractionQueue.then(async () => {
					const frames: ExtractFilmstripFrameItem[] = [];
					for (const timeMs of sanitizedTimes) {
						if (event.sender.isDestroyed()) {
							break;
						}
						try {
							const jpegData = await extractFilmstripFrameJpeg({
								ffmpegPath,
								inputPath: approvedPath,
								timeMs,
								width: options.width,
								height: options.height,
							});
							if (jpegData && jpegData.byteLength > 0) {
								frames.push({ timeMs, jpegData });
							}
						} catch {
							// Skip individual timestamp decode failures; caller falls back if needed.
						}
					}
					return frames;
				});

				extractionQueue = job.catch(() => undefined);
				const frames = await job;

				return {
					success: frames.length > 0,
					frames,
					...(frames.length === 0
						? { error: "No filmstrip frames could be extracted" }
						: {}),
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
