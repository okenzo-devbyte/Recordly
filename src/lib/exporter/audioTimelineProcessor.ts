import type { SpeedRegion } from "@/components/video-editor/types";
import { AudioProcessorBase } from "./audioProcessorBase";
import type { TimelineSlice, TrimLikeRegion } from "./audioProcessorShared";
import { stretchChannelDataWsola } from "./audioTimeStretch";

export class AudioTimelineProcessor extends AudioProcessorBase {
	protected prestretchedSliceCache = new Map<string, Float32Array[]>();

	protected getStretchCacheKey(
		buffer: AudioBuffer,
		speed: number,
		sourceOffsetSec: number,
		sourceDurationSec: number,
		audibleDurationSec: number,
	): string | null {
		let bufferId = this.bufferIds.get(buffer);
		if (bufferId === undefined) {
			bufferId = ++this.nextBufferId;
			this.bufferIds.set(buffer, bufferId);
		}
		return `${bufferId}:${speed.toFixed(4)}:${sourceOffsetSec.toFixed(4)}:${sourceDurationSec.toFixed(4)}:${audibleDurationSec.toFixed(4)}`;
	}

	private bufferIds = new WeakMap<AudioBuffer, number>();
	private nextBufferId = 0;

	protected buildTimelineSlices(
		sourceDurationMs: number,
		trimRegions: TrimLikeRegion[],
		speedRegions: SpeedRegion[],
	): TimelineSlice[] {
		const boundaries = new Set<number>();
		boundaries.add(0);
		boundaries.add(sourceDurationMs);

		for (const trim of trimRegions) {
			if (trim.startMs >= 0 && trim.startMs <= sourceDurationMs) boundaries.add(trim.startMs);
			if (trim.endMs >= 0 && trim.endMs <= sourceDurationMs) boundaries.add(trim.endMs);
		}
		for (const speed of speedRegions) {
			if (speed.startMs >= 0 && speed.startMs <= sourceDurationMs)
				boundaries.add(speed.startMs);
			if (speed.endMs >= 0 && speed.endMs <= sourceDurationMs) boundaries.add(speed.endMs);
		}

		const sorted = [...boundaries].sort((a, b) => a - b);
		const slices: TimelineSlice[] = [];

		for (let i = 0; i < sorted.length - 1; i++) {
			const start = sorted[i];
			const end = sorted[i + 1];
			if (end - start < 0.001) continue;

			// Skip segments entirely inside a trim region
			const midpoint = (start + end) / 2;
			if (this.isInTrimRegion(midpoint, trimRegions)) continue;

			const speedRegion = speedRegions.find(
				(s) => midpoint >= s.startMs && midpoint < s.endMs,
			);

			slices.push({
				sourceStartMs: start,
				sourceEndMs: end,
				speed: speedRegion?.speed ?? 1,
			});
		}

		return slices;
	}

	// Map a source-timeline timestamp to the corresponding output-timeline timestamp.
	protected sourceTimeToOutputTime(sourceMs: number, slices: TimelineSlice[]): number {
		let outputMs = 0;

		for (const slice of slices) {
			if (sourceMs <= slice.sourceStartMs) {
				return outputMs;
			}
			const sliceDurationMs = slice.sourceEndMs - slice.sourceStartMs;
			if (sourceMs >= slice.sourceEndMs) {
				outputMs += sliceDurationMs / slice.speed;
				continue;
			}
			// Source time falls within this slice
			outputMs += (sourceMs - slice.sourceStartMs) / slice.speed;
			return outputMs;
		}

		return outputMs;
	}

	// Schedule an AudioBuffer through the timeline slices in an OfflineAudioContext.
	// Each non-trimmed segment creates an AudioBufferSourceNode with the appropriate
	// playbackRate for speed regions. When chunkOutputStartSec/chunkDurationSec are
	// provided, only sources overlapping the chunk window are scheduled.
	protected scheduleBufferThroughTimeline(
		ctx: OfflineAudioContext,
		buffer: AudioBuffer,
		slices: TimelineSlice[],
		sourceStartDelaySec: number,
		gain = 1,
		chunkOutputStartSec = 0,
		chunkDurationSec = Number.POSITIVE_INFINITY,
		mutedOutputRangesSec: Array<{ startSec: number; endSec: number }> = [],
		sourceTrackId?: keyof NonNullable<TimelineSlice["sourceGains"]>,
	): void {
		let outputOffsetSec = 0;

		for (const slice of slices) {
			const sliceSourceDurationSec = (slice.sourceEndMs - slice.sourceStartMs) / 1000;
			if (slice.outputStartMs !== undefined) outputOffsetSec = slice.outputStartMs / 1000;
			const sliceOutputDurationSec = sliceSourceDurationSec / slice.speed;

			// Where in the buffer does this slice read from?
			const bufferOffsetSec = slice.sourceStartMs / 1000 - sourceStartDelaySec;

			// Skip if slice doesn't overlap with the buffer at all
			if (
				bufferOffsetSec + sliceSourceDurationSec <= 0 ||
				bufferOffsetSec >= buffer.duration
			) {
				outputOffsetSec += sliceOutputDurationSec;
				continue;
			}

			// Clamp to buffer bounds
			let effectiveBufferStartSec = Math.max(0, bufferOffsetSec);
			const trimmedFromStartSec = effectiveBufferStartSec - bufferOffsetSec;
			let effectiveSourceDurationSec = Math.min(
				sliceSourceDurationSec - trimmedFromStartSec,
				buffer.duration - effectiveBufferStartSec,
			);

			if (effectiveSourceDurationSec <= 0.001) {
				outputOffsetSec += sliceOutputDurationSec;
				continue;
			}

			// Calculate output position (global then chunk-local)
			let localOutputStartSec =
				outputOffsetSec + trimmedFromStartSec / slice.speed - chunkOutputStartSec;
			let localOutputEndSec = localOutputStartSec + effectiveSourceDurationSec / slice.speed;

			// Skip if entirely outside chunk window
			if (localOutputEndSec <= 0 || localOutputStartSec >= chunkDurationSec) {
				outputOffsetSec += sliceOutputDurationSec;
				continue;
			}

			// Clip to chunk start
			if (localOutputStartSec < 0) {
				const skipOutputSec = -localOutputStartSec;
				const skipSourceSec = skipOutputSec * slice.speed;
				effectiveBufferStartSec += skipSourceSec;
				effectiveSourceDurationSec -= skipSourceSec;
				localOutputStartSec = 0;
			}

			// Clip to chunk end
			if (localOutputEndSec > chunkDurationSec) {
				const excessOutputSec = localOutputEndSec - chunkDurationSec;
				effectiveSourceDurationSec -= excessOutputSec * slice.speed;
			}

			if (effectiveSourceDurationSec <= 0.001) {
				outputOffsetSec += sliceOutputDurationSec;
				continue;
			}

			const audibleRanges: Array<{ startSec: number; endSec: number }> = [
				{
					startSec: localOutputStartSec + chunkOutputStartSec,
					endSec:
						localOutputStartSec +
						chunkOutputStartSec +
						effectiveSourceDurationSec / slice.speed,
				},
			];
			for (const mutedRange of mutedOutputRangesSec) {
				for (let rangeIndex = audibleRanges.length - 1; rangeIndex >= 0; rangeIndex -= 1) {
					const current = audibleRanges[rangeIndex];
					const overlapStart = Math.max(current.startSec, mutedRange.startSec);
					const overlapEnd = Math.min(current.endSec, mutedRange.endSec);
					if (overlapEnd <= overlapStart) {
						continue;
					}
					audibleRanges.splice(rangeIndex, 1);
					if (current.startSec < overlapStart) {
						audibleRanges.push({ startSec: current.startSec, endSec: overlapStart });
					}
					if (overlapEnd < current.endSec) {
						audibleRanges.push({ startSec: overlapEnd, endSec: current.endSec });
					}
				}
			}

			for (const audibleRange of audibleRanges) {
				const audibleDurationSec = audibleRange.endSec - audibleRange.startSec;
				if (audibleDurationSec <= 0.001) {
					continue;
				}
				const source = ctx.createBufferSource();
				const gainNode = ctx.createGain();
				gainNode.gain.value = Math.max(
					0,
					Math.min(2, (sourceTrackId && slice.sourceGains?.[sourceTrackId]) ?? gain),
				);

				const sourceOffsetSec =
					effectiveBufferStartSec +
					(audibleRange.startSec - (localOutputStartSec + chunkOutputStartSec)) *
						slice.speed;
				const localStartSec = audibleRange.startSec - chunkOutputStartSec;
				const sourceDurationSec = audibleDurationSec * slice.speed;

				const stretchedBuffer = this.stretchAudioBuffer(
					buffer,
					slice.speed,
					sourceOffsetSec,
					sourceDurationSec,
					audibleDurationSec,
					ctx,
				);

				source.buffer = stretchedBuffer;
				source.playbackRate.value = 1;
				source.connect(gainNode);
				gainNode.connect(ctx.destination);

				source.start(localStartSec);
			}

			outputOffsetSec += sliceOutputDurationSec;
		}
	}

	protected stretchAudioBuffer(
		originalBuffer: AudioBuffer,
		speed: number,
		sourceOffsetSec: number,
		sourceDurationSec: number,
		audibleDurationSec: number,
		ctx: BaseAudioContext,
	): AudioBuffer {
		const sampleRate = originalBuffer.sampleRate;
		const channels = originalBuffer.numberOfChannels;

		const cacheKey = this.getStretchCacheKey(
			originalBuffer,
			speed,
			sourceOffsetSec,
			sourceDurationSec,
			audibleDurationSec,
		);
		const cachedChannels = cacheKey ? this.prestretchedSliceCache.get(cacheKey) : undefined;
		if (cachedChannels && cachedChannels.length > 0) {
			if (cacheKey) {
				this.prestretchedSliceCache.delete(cacheKey);
			}
			const length = Math.max(1, cachedChannels[0].length);
			const outBuffer = ctx.createBuffer(channels, length, sampleRate);
			for (let c = 0; c < channels; c++) {
				const chData = cachedChannels[c];
				if (chData) {
					outBuffer.getChannelData(c).set(chData);
				}
			}
			return outBuffer;
		}

		const inputChannels = Array.from({ length: channels }, (_, c) =>
			originalBuffer.getChannelData(c),
		);
		const stretchedChannels = stretchChannelDataWsola({
			inputChannels,
			sampleRate,
			speed,
			sourceOffsetSec,
			sourceDurationSec,
			audibleDurationSec,
		});
		const length = Math.max(1, stretchedChannels[0]?.length ?? 1);
		const outBuffer = ctx.createBuffer(channels, length, sampleRate);
		for (let c = 0; c < channels; c++) {
			const chData = stretchedChannels[c];
			if (chData) {
				outBuffer.getChannelData(c).set(chData);
			}
		}
		return outBuffer;
	}

	// Create a WAV file header for the given audio parameters.
}
