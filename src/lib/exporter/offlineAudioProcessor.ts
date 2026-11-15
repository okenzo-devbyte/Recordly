import { SOURCE_AUDIO_NORMALIZE_GAIN } from "@/components/video-editor/audio/audioTypes";
import type {
	AudioRegion,
	ClipRegion,
	SourceAudioTrackSettings,
	SpeedRegion,
} from "@/components/video-editor/types";
import {
	getClipSourceEndMs,
	getClipSourceStartMs,
	getTimelineDurationMs,
} from "@/components/video-editor/types";
import { buildResolvedAudioPlan } from "@/lib/exporter/audioRoutingEngine";
import { estimateCompanionAudioStartDelaySeconds } from "@/lib/mediaTiming";
import { AudioMediaProcessor } from "./audioMediaProcessor";
import {
	AUDIO_BITRATE,
	ENCODE_BACKPRESSURE_LIMIT,
	getSourceTrackIdFromPath,
	MP4_AUDIO_CODEC,
	OFFLINE_AUDIO_SAMPLE_RATE,
	OFFLINE_CHUNK_DURATION_SEC,
	OFFLINE_ENCODE_CHUNK_FRAMES,
	type PreparedOfflineRender,
	resolveSourceTrackGain,
	softLimitOfflineMixPeaksInPlace,
	type TimelineSlice,
	type TrimLikeRegion,
} from "./audioProcessorShared";
import type { VideoMuxer } from "./muxer";

export class OfflineAudioProcessor extends AudioMediaProcessor {
	protected async renderAndMuxOfflineAudio(
		videoUrl: string,
		trimRegions: TrimLikeRegion[],
		speedRegions: SpeedRegion[],
		audioRegions: AudioRegion[],
		sourceAudioFallbackPaths: string[],
		sourceAudioFallbackStartDelayMsByPath: Record<string, number> | undefined,
		sourceAudioTrackSettings: SourceAudioTrackSettings | undefined,
		clipRegions: ClipRegion[] | undefined,
		muxer: VideoMuxer,
		sourceAudioTrackSettingsByClip?: Record<string, SourceAudioTrackSettings>,
	): Promise<void> {
		const prepared = await this.prepareOfflineRender(
			videoUrl,
			trimRegions,
			speedRegions,
			audioRegions,
			sourceAudioFallbackPaths,
			sourceAudioFallbackStartDelayMsByPath,
			sourceAudioTrackSettings,
			clipRegions,
			sourceAudioTrackSettingsByClip,
		);
		if (this.cancelled) return;
		await this.renderAndEncodeChunked(prepared, muxer);
	}

	protected async prepareOfflineRender(
		videoUrl: string,
		trimRegions: TrimLikeRegion[],
		speedRegions: SpeedRegion[],
		audioRegions: AudioRegion[],
		sourceAudioFallbackPaths: string[],
		sourceAudioFallbackStartDelayMsByPath?: Record<string, number>,
		sourceAudioTrackSettings?: SourceAudioTrackSettings,
		clipRegions?: ClipRegion[],
		sourceAudioTrackSettingsByClip?: Record<string, SourceAudioTrackSettings>,
	): Promise<PreparedOfflineRender> {
		if (this.cancelled) throw new Error("Export cancelled");
		this.onProgress?.(0);

		const resolvedPlan = buildResolvedAudioPlan({
			videoResource: videoUrl,
			sourceAudioFallbackPaths,
			audioRegions,
			sourceTrackGainById: {
				mic: resolveSourceTrackGain(sourceAudioTrackSettings, "mic"),
				system: resolveSourceTrackGain(sourceAudioTrackSettings, "system"),
				mixed: resolveSourceTrackGain(sourceAudioTrackSettings, "mixed"),
			},
		});

		// A microphone sidecar makes the embedded recording the system track.
		// Saved settings may retain both keys after track metadata changes.
		const embeddedTrackId = resolvedPlan.pathsByTrack.mic ? "system" : "mixed";

		// Decode embedded source audio separately from companion sidecars.
		const mainBuffer = resolvedPlan.includeEmbeddedInExport
			? await this.decodeAudioFromUrl(videoUrl)
			: null;
		const mainBufferGain = resolveSourceTrackGain(sourceAudioTrackSettings, embeddedTrackId);
		const mainBufferEntry = mainBuffer ? { buffer: mainBuffer, gain: mainBufferGain } : null;
		if (this.cancelled) throw new Error("Export cancelled");

		// Decode companion / sidecar audio files
		const companionEntries: Array<{
			buffer: AudioBuffer;
			startDelaySec: number;
			gain: number;
			trackId: ReturnType<typeof getSourceTrackIdFromPath>;
		}> = [];
		const refDuration =
			mainBuffer?.duration ??
			(resolvedPlan.playbackPaths.length > 0 ? await this.getMediaDurationSec(videoUrl) : 0);
		for (const audioPath of resolvedPlan.playbackPaths) {
			if (this.cancelled) throw new Error("Export cancelled");
			const buffer = await this.decodeAudioFromUrl(audioPath);
			if (!buffer) continue;

			companionEntries.push({
				buffer,
				trackId: getSourceTrackIdFromPath(audioPath),
				gain: resolveSourceTrackGain(
					sourceAudioTrackSettings,
					getSourceTrackIdFromPath(audioPath),
				),
				startDelaySec: estimateCompanionAudioStartDelaySeconds(
					refDuration,
					buffer.duration,
					sourceAudioFallbackStartDelayMsByPath?.[audioPath],
				),
			});
		}
		if (this.cancelled) throw new Error("Export cancelled");

		// Decode audio region overlay files
		const regionEntries: Array<{ buffer: AudioBuffer; region: AudioRegion }> = [];
		for (const region of audioRegions) {
			if (this.cancelled) throw new Error("Export cancelled");
			const buffer = await this.decodeAudioFromUrl(region.audioPath);
			if (buffer) regionEntries.push({ buffer, region });
		}

		this.onProgress?.(0.2);

		// Determine source duration for timeline calculation
		const primaryBuffer = mainBufferEntry?.buffer ?? companionEntries[0]?.buffer ?? null;
		if (!primaryBuffer && regionEntries.length === 0) {
			throw new Error("No decodable audio sources found");
		}

		let sourceDurationSec: number;
		if (mainBufferEntry?.buffer) {
			sourceDurationSec = mainBufferEntry.buffer.duration;
		} else if (resolvedPlan.playbackPaths.length > 0 || regionEntries.length > 0) {
			sourceDurationSec = await this.getMediaDurationSec(videoUrl);
		} else {
			sourceDurationSec = primaryBuffer?.duration ?? 0;
		}
		const sourceDurationMs = sourceDurationSec * 1000;

		// Build timeline slices (non-trimmed segments with speed info)
		const slices: TimelineSlice[] = clipRegions
			? clipRegions.map((clip) => ({
					sourceStartMs: getClipSourceStartMs(clip),
					sourceEndMs: getClipSourceEndMs(clip),
					speed: clip.speed,
					outputStartMs: clip.startMs,
					...(sourceAudioTrackSettingsByClip
						? {
								sourceGains: this.resolveClipSourceGains(
									clip.id,
									sourceAudioTrackSettings,
									sourceAudioTrackSettingsByClip,
									embeddedTrackId,
								),
							}
						: {}),
				}))
			: this.buildTimelineSlices(sourceDurationMs, trimRegions, speedRegions);

		let outputDurationMs = 0;
		for (const slice of slices) {
			outputDurationMs += (slice.sourceEndMs - slice.sourceStartMs) / slice.speed;
		}
		if (clipRegions) outputDurationMs = getTimelineDurationMs(clipRegions, sourceDurationMs);

		// Extend for audio regions that might exceed the video timeline
		for (const { region } of regionEntries) {
			const regionEndOutput = clipRegions
				? region.endMs
				: this.sourceTimeToOutputTime(region.endMs, slices);
			outputDurationMs = Math.max(outputDurationMs, regionEndOutput);
		}

		const numChannels = Math.min(primaryBuffer?.numberOfChannels ?? 2, 2);
		const mutedSourceOutputRangesSec = (clipRegions ?? [])
			.filter(
				(clip) =>
					Boolean(clip.muted) &&
					Number.isFinite(clip.startMs) &&
					Number.isFinite(clip.endMs) &&
					clip.endMs > clip.startMs,
			)
			.map((clip) => ({
				startSec: Math.max(0, clip.startMs / 1000),
				endSec: Math.max(0, clip.endMs / 1000),
			}));

		return {
			usesClipTimeline: clipRegions !== undefined,
			mainBufferEntry,
			companionEntries,
			regionEntries,
			mutedSourceOutputRangesSec,
			slices,
			outputDurationMs,
			numChannels,
		};
	}

	private resolveClipSourceGains(
		clipId: string,
		defaults: SourceAudioTrackSettings | undefined,
		settingsByClip: Record<string, SourceAudioTrackSettings>,
		embeddedTrackId: "mixed" | "system",
	): NonNullable<TimelineSlice["sourceGains"]> {
		const settings = { ...defaults, ...settingsByClip[clipId] };
		return {
			mic: resolveSourceTrackGain(settings, "mic"),
			system: resolveSourceTrackGain(settings, "system"),
			mixed: resolveSourceTrackGain(settings, "mixed"),
			embedded: resolveSourceTrackGain(settings, embeddedTrackId),
		};
	}

	// Render timeline in chunks and encode each chunk to the muxer immediately.
	// Memory is bounded to ~OFFLINE_CHUNK_DURATION_SEC of PCM per chunk
	// instead of holding the entire output buffer in memory.
	protected async renderAndEncodeChunked(
		prepared: PreparedOfflineRender,
		muxer: VideoMuxer,
	): Promise<void> {
		const { numChannels } = prepared;
		const totalOutputSec = Math.max(prepared.outputDurationMs / 1000, 0.01);

		let encodeError: Error | null = null;
		let muxError: Error | null = null;
		let pendingMuxing = Promise.resolve();
		let wroteFirstChunk = false;

		const encodeConfig: AudioEncoderConfig = {
			codec: MP4_AUDIO_CODEC,
			sampleRate: OFFLINE_AUDIO_SAMPLE_RATE,
			numberOfChannels: numChannels,
			bitrate: AUDIO_BITRATE,
		};

		const supported = await AudioEncoder.isConfigSupported(encodeConfig);
		if (!supported.supported) {
			console.warn("[AudioProcessor] AAC encoding not supported for offline audio");
			return;
		}

		const encoder = new AudioEncoder({
			output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
				pendingMuxing = pendingMuxing
					.then(async () => {
						if (this.cancelled) return;
						await muxer.addAudioChunk(chunk, !wroteFirstChunk ? meta : undefined);
						wroteFirstChunk = true;
					})
					.catch((error) => {
						muxError = error instanceof Error ? error : new Error(String(error));
					});
			},
			error: (error: DOMException) => {
				encodeError = new Error(`Audio encode error: ${error.message}`);
			},
		});
		encoder.configure(encodeConfig);

		try {
			await this.renderChunked(
				prepared,
				totalOutputSec,
				async (rendered, outputOffsetSec) => {
					if (encodeError) throw encodeError;
					if (muxError) throw muxError;
					await this.feedBufferToEncoder(encoder, rendered, outputOffsetSec);
				},
			);

			if (encodeError) throw encodeError;
			if (muxError) throw muxError;

			if (encoder.state === "configured") {
				await encoder.flush();
			}

			await pendingMuxing;

			if (encodeError) throw encodeError;
			if (muxError) throw muxError;
		} finally {
			if (encoder.state === "configured") {
				encoder.close();
			}
		}
	}

	// Render timeline to a WAV blob for the native/FFmpeg export path.
	// Processes in chunks to avoid holding the entire output in memory.
	protected async renderToWavBlobChunked(prepared: PreparedOfflineRender): Promise<Blob> {
		const totalOutputSec = Math.max(prepared.outputDurationMs / 1000, 0.01);
		const totalFrames = Math.ceil(totalOutputSec * OFFLINE_AUDIO_SAMPLE_RATE);
		const numChannels = prepared.numChannels;

		const header = this.createWavHeader(OFFLINE_AUDIO_SAMPLE_RATE, numChannels, totalFrames);
		const pcmParts: ArrayBuffer[] = [header];

		await this.renderChunked(prepared, totalOutputSec, async (rendered) => {
			pcmParts.push(...this.audioBufferToPcmParts(rendered));
		});
		if (this.cancelled) throw new Error("Export cancelled");

		return new Blob(pcmParts, { type: "audio/wav" });
	}

	private timeStretchWorker: Worker | null = null;
	private timeStretchRequestSeq = 0;
	private timeStretchResolvers = new Map<
		number,
		{ resolve: (channels: Float32Array[]) => void; reject: (error: Error) => void }
	>();

	private getOrCreateTimeStretchWorker(): Worker | null {
		if (this.timeStretchWorker) {
			return this.timeStretchWorker;
		}
		if (typeof Worker === "undefined") {
			return null;
		}
		try {
			const worker = new Worker(new URL("./audioTimeStretch.worker.ts", import.meta.url), {
				type: "module",
			});
			worker.addEventListener("message", (event) => {
				const { requestId, outputChannels, error } = event.data ?? {};
				const resolver = this.timeStretchResolvers.get(requestId);
				if (!resolver) return;
				this.timeStretchResolvers.delete(requestId);
				if (error) {
					resolver.reject(new Error(error));
				} else if (outputChannels) {
					resolver.resolve(outputChannels);
				}
			});
			worker.addEventListener("error", (event) => {
				const err = event.error ?? new Error(event.message || "Time-stretch worker failed");
				for (const resolver of this.timeStretchResolvers.values()) {
					resolver.reject(err);
				}
				this.timeStretchResolvers.clear();
				this.disposeTimeStretchWorker();
			});
			this.timeStretchWorker = worker;
			return worker;
		} catch {
			return null;
		}
	}

	private disposeTimeStretchWorker(): void {
		if (!this.timeStretchWorker) return;
		try {
			this.timeStretchWorker.terminate();
		} catch {
			// ignore
		}
		this.timeStretchWorker = null;
		this.timeStretchResolvers.clear();
	}

	private async preStretchBufferForChunk(
		buffer: AudioBuffer,
		slices: TimelineSlice[],
		sourceStartDelaySec: number,
		chunkOutputStartSec: number,
		chunkDurationSec: number,
		mutedOutputRangesSec: Array<{ startSec: number; endSec: number }>,
	): Promise<void> {
		if (typeof buffer.getChannelData !== "function") {
			return;
		}
		const hasNonUnitySpeed = slices.some((s) => Math.abs(s.speed - 1) >= 0.001);
		if (!hasNonUnitySpeed) {
			return;
		}
		const worker = this.getOrCreateTimeStretchWorker();
		if (!worker) {
			return;
		}

		let outputOffsetSec = 0;
		for (const slice of slices) {
			const sliceSourceDurationSec = (slice.sourceEndMs - slice.sourceStartMs) / 1000;
			if (slice.outputStartMs !== undefined) outputOffsetSec = slice.outputStartMs / 1000;
			const sliceOutputDurationSec = sliceSourceDurationSec / slice.speed;
			const bufferOffsetSec = slice.sourceStartMs / 1000 - sourceStartDelaySec;

			if (
				bufferOffsetSec + sliceSourceDurationSec <= 0 ||
				bufferOffsetSec >= buffer.duration
			) {
				outputOffsetSec += sliceOutputDurationSec;
				continue;
			}

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

			let localOutputStartSec =
				outputOffsetSec + trimmedFromStartSec / slice.speed - chunkOutputStartSec;
			const localOutputEndSec = localOutputStartSec + effectiveSourceDurationSec / slice.speed;
			if (localOutputEndSec <= 0 || localOutputStartSec >= chunkDurationSec) {
				outputOffsetSec += sliceOutputDurationSec;
				continue;
			}

			if (localOutputStartSec < 0) {
				const skipOutputSec = -localOutputStartSec;
				const skipSourceSec = skipOutputSec * slice.speed;
				effectiveBufferStartSec += skipSourceSec;
				effectiveSourceDurationSec -= skipSourceSec;
				localOutputStartSec = 0;
			}
			if (localOutputEndSec > chunkDurationSec) {
				const excessOutputSec = localOutputEndSec - chunkDurationSec;
				effectiveSourceDurationSec -= excessOutputSec * slice.speed;
			}
			if (effectiveSourceDurationSec <= 0.001) {
				outputOffsetSec += sliceOutputDurationSec;
				continue;
			}

			if (Math.abs(slice.speed - 1) < 0.001) {
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
					if (overlapEnd <= overlapStart) continue;
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
				if (audibleDurationSec <= 0.001) continue;

				const sourceOffsetSec =
					effectiveBufferStartSec +
					(audibleRange.startSec - (localOutputStartSec + chunkOutputStartSec)) *
						slice.speed;
				const sourceDurationSec = audibleDurationSec * slice.speed;
				const cacheKey = this.getStretchCacheKey(
					buffer,
					slice.speed,
					sourceOffsetSec,
					sourceDurationSec,
					audibleDurationSec,
				);
				if (!cacheKey || this.prestretchedSliceCache.has(cacheKey)) continue;

				try {
					const inputChannels = Array.from(
						{ length: buffer.numberOfChannels },
						(_, c) => buffer.getChannelData(c).slice(),
					);
					const outputChannels = await new Promise<Float32Array[]>((resolve, reject) => {
						const requestId = ++this.timeStretchRequestSeq;
						this.timeStretchResolvers.set(requestId, { resolve, reject });
						worker.postMessage(
							{
								requestId,
								inputChannels,
								sampleRate: buffer.sampleRate,
								speed: slice.speed,
								sourceOffsetSec,
								sourceDurationSec,
								audibleDurationSec,
							},
							inputChannels.map((ch) => ch.buffer),
						);
					});
					this.prestretchedSliceCache.set(cacheKey, outputChannels);
				} catch {
					// Fall back to synchronous stretchAudioBuffer on main thread if worker fails
				}
			}

			outputOffsetSec += sliceOutputDurationSec;
		}
	}

	// Shared chunked rendering loop. Processes the timeline in
	// OFFLINE_CHUNK_DURATION_SEC segments, calling onChunk for each rendered buffer.
	protected async renderChunked(
		prepared: PreparedOfflineRender,
		totalOutputSec: number,
		onChunk: (
			rendered: AudioBuffer,
			outputOffsetSec: number,
			chunkIndex: number,
		) => Promise<void>,
	): Promise<void> {
		const { slices, numChannels } = prepared;
		let outputOffsetSec = 0;
		const chunkCount = Math.ceil(totalOutputSec / OFFLINE_CHUNK_DURATION_SEC);

		try {
			for (let i = 0; i < chunkCount && !this.cancelled; i++) {
				const chunkSec = Math.min(
					OFFLINE_CHUNK_DURATION_SEC,
					totalOutputSec - outputOffsetSec,
				);
				const chunkFrames = Math.ceil(chunkSec * OFFLINE_AUDIO_SAMPLE_RATE);

				if (prepared.mainBufferEntry) {
					await this.preStretchBufferForChunk(
						prepared.mainBufferEntry.buffer,
						slices,
						0,
						outputOffsetSec,
						chunkSec,
						prepared.mutedSourceOutputRangesSec,
					);
				}
				for (const entry of prepared.companionEntries) {
					await this.preStretchBufferForChunk(
						entry.buffer,
						slices,
						entry.startDelaySec,
						outputOffsetSec,
						chunkSec,
						prepared.mutedSourceOutputRangesSec,
					);
				}

				const offlineCtx = new OfflineAudioContext(
					numChannels,
					chunkFrames,
					OFFLINE_AUDIO_SAMPLE_RATE,
				);

				// Schedule main audio
				if (prepared.mainBufferEntry) {
					this.scheduleBufferThroughTimeline(
						offlineCtx,
						prepared.mainBufferEntry.buffer,
						slices,
						0,
						prepared.mainBufferEntry.gain,
						outputOffsetSec,
						chunkSec,
						prepared.mutedSourceOutputRangesSec,
						"embedded",
					);
				}

				// Schedule companion/sidecar audio
				for (const entry of prepared.companionEntries) {
					this.scheduleBufferThroughTimeline(
						offlineCtx,
						entry.buffer,
						slices,
						entry.startDelaySec,
						entry.gain,
						outputOffsetSec,
						chunkSec,
						prepared.mutedSourceOutputRangesSec,
						entry.trackId,
					);
				}

				// Schedule audio region overlays
				for (const { buffer, region } of prepared.regionEntries) {
					this.scheduleRegionForChunk(
						offlineCtx,
						buffer,
						region,
						slices,
						outputOffsetSec,
						chunkSec,
						prepared.usesClipTimeline,
					);
				}

				const rendered = await offlineCtx.startRendering();
				if (this.cancelled) break;
				softLimitOfflineMixPeaksInPlace(rendered);

				await onChunk(rendered, outputOffsetSec, i);

				outputOffsetSec += chunkSec;
				this.onProgress?.(0.3 + (outputOffsetSec / totalOutputSec) * 0.7);
			}
		} finally {
			this.prestretchedSliceCache.clear();
			this.disposeTimeStretchWorker();
		}
	}

	// Schedule an audio region overlay clipped to a specific chunk window.
	protected scheduleRegionForChunk(
		ctx: OfflineAudioContext,
		buffer: AudioBuffer,
		region: AudioRegion,
		slices: TimelineSlice[],
		chunkOutputStartSec: number,
		chunkDurationSec: number,
		usesClipTimeline = false,
	): void {
		const outputStartMs = usesClipTimeline
			? region.startMs
			: this.sourceTimeToOutputTime(region.startMs, slices);
		const outputEndMs = usesClipTimeline
			? region.endMs
			: this.sourceTimeToOutputTime(region.endMs, slices);

		let localStartSec = outputStartMs / 1000 - chunkOutputStartSec;
		let localEndSec = outputEndMs / 1000 - chunkOutputStartSec;

		// Skip if region doesn't overlap with this chunk
		if (localEndSec <= 0 || localStartSec >= chunkDurationSec) return;

		// Clip to chunk bounds
		let bufferOffsetSec = 0;
		if (localStartSec < 0) {
			bufferOffsetSec = -localStartSec;
			localStartSec = 0;
		}
		if (localEndSec > chunkDurationSec) {
			localEndSec = chunkDurationSec;
		}

		const duration = Math.min(localEndSec - localStartSec, buffer.duration - bufferOffsetSec);
		if (duration <= 0.001) return;

		const gainNode = ctx.createGain();
		const normalizeGain = region.normalize ? SOURCE_AUDIO_NORMALIZE_GAIN : 1;
		gainNode.gain.value = Math.max(0, Math.min(1, region.volume * normalizeGain));
		gainNode.connect(ctx.destination);

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(gainNode);
		source.start(localStartSec, bufferOffsetSec, duration);
	}

	// Feed a rendered AudioBuffer chunk to an AudioEncoder with a timestamp offset.
	protected async feedBufferToEncoder(
		encoder: AudioEncoder,
		buffer: AudioBuffer,
		timestampOffsetSec: number,
	): Promise<void> {
		const sampleRate = buffer.sampleRate;
		const numChannels = buffer.numberOfChannels;
		const totalFrames = buffer.length;

		for (
			let offset = 0;
			offset < totalFrames && !this.cancelled;
			offset += OFFLINE_ENCODE_CHUNK_FRAMES
		) {
			const frameCount = Math.min(OFFLINE_ENCODE_CHUNK_FRAMES, totalFrames - offset);

			const planarData = new Float32Array(frameCount * numChannels);
			for (let ch = 0; ch < numChannels; ch++) {
				const channelData = buffer.getChannelData(ch);
				planarData.set(channelData.subarray(offset, offset + frameCount), ch * frameCount);
			}

			const audioData = new AudioData({
				format: "f32-planar",
				sampleRate,
				numberOfFrames: frameCount,
				numberOfChannels: numChannels,
				timestamp: Math.round((offset / sampleRate + timestampOffsetSec) * 1_000_000),
				data: planarData,
			});

			encoder.encode(audioData);
			audioData.close();

			while (encoder.encodeQueueSize >= ENCODE_BACKPRESSURE_LIMIT && !this.cancelled) {
				await new Promise((r) => setTimeout(r, 1));
			}
		}
	}

	// Decode audio from a URL using streaming WebCodecs decode with bulk fallback.
	// Streaming decode avoids holding the full compressed file in memory alongside
	// the decoded AudioBuffer, reducing peak memory for large recordings.
}
