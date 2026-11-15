import { describe, expect, it } from "vitest";
import { buildFilmstripFrameFfmpegArgs } from "./extract";

describe("filmstrip FFmpeg args builder", () => {
	it("places fast seek -ss before -i and scales/crops to 160x90 JPEG pipe", () => {
		const args = buildFilmstripFrameFfmpegArgs({
			inputPath: "/videos/sample.mp4",
			timeMs: 2_500,
		});

		const ssIndex = args.indexOf("-ss");
		const inputIndex = args.indexOf("-i");
		expect(ssIndex).toBeGreaterThan(-1);
		expect(inputIndex).toBeGreaterThan(ssIndex);
		expect(args[ssIndex + 1]).toBe("2.500");
		expect(args).toEqual(
			expect.arrayContaining([
				"-threads",
				"1",
				"-frames:v",
				"1",
				"-vf",
				"scale=160:90:force_original_aspect_ratio=increase,crop=160:90",
				"-vcodec",
				"mjpeg",
				"pipe:1",
			]),
		);
	});
});
