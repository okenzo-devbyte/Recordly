export interface StretchChannelDataOptions {
	inputChannels: Float32Array[];
	sampleRate: number;
	speed: number;
	sourceOffsetSec: number;
	sourceDurationSec: number;
	audibleDurationSec: number;
}

export function stretchChannelDataWsola(options: StretchChannelDataOptions): Float32Array[] {
	const {
		inputChannels,
		sampleRate,
		speed,
		sourceOffsetSec,
		sourceDurationSec,
		audibleDurationSec,
	} = options;
	const channels = Math.max(1, inputChannels.length);
	const inputLength = inputChannels[0]?.length ?? 0;

	const startSample = Math.max(0, Math.floor(sourceOffsetSec * sampleRate));
	const sourceSamples = Math.floor(sourceDurationSec * sampleRate);
	const endSample = Math.min(inputLength, startSample + sourceSamples);

	const outSamples = Math.floor(audibleDurationSec * sampleRate);
	if (outSamples <= 0 || startSample >= inputLength) {
		return Array.from({ length: channels }, () => new Float32Array(1));
	}

	const outputChannels = Array.from({ length: channels }, () => new Float32Array(outSamples));

	if (Math.abs(speed - 1) < 0.001) {
		const copyLength = Math.min(endSample - startSample, outSamples);
		if (copyLength > 0) {
			for (let c = 0; c < channels; c++) {
				const src = inputChannels[c];
				if (src) {
					outputChannels[c].set(src.subarray(startSample, startSample + copyLength), 0);
				}
			}
		}
		return outputChannels;
	}

	// WSOLA uses windowing which causes fade-in at the start and fade-out at the end.
	// To avoid clicks at chunk boundaries, we render with 100ms of padding and trim it.
	const paddingSec = 0.1;
	const paddingOutSamples = Math.floor(sampleRate * paddingSec);
	const paddingInSamples = Math.floor(paddingOutSamples * speed);

	const workStartIn = Math.max(0, startSample - paddingInSamples);
	const workEndIn = Math.min(inputLength, endSample + paddingInSamples);

	const actualPaddingInStart = startSample - workStartIn;
	const actualPaddingOutStart = Math.floor(actualPaddingInStart / speed);

	const windowSize = Math.floor(sampleRate * 0.04);
	const hopOut = Math.floor(windowSize * 0.5);
	const hopIn = Math.floor(hopOut * speed);
	const searchRange = Math.floor(sampleRate * 0.015);

	const workOutSamples = Math.floor((workEndIn - workStartIn) / speed) + windowSize * 2;
	const workOutDataByChannel = Array.from(
		{ length: channels },
		() => new Float32Array(workOutSamples),
	);

	const window = new Float32Array(windowSize);
	for (let i = 0; i < windowSize; i++) {
		window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
	}

	let inOffset = workStartIn;
	let outOffset = 0;

	// Initial window
	for (let i = 0; i < windowSize; i++) {
		if (inOffset + i < workEndIn && outOffset + i < workOutSamples) {
			for (let c = 0; c < channels; c++) {
				const inData = inputChannels[c];
				if (inData) {
					workOutDataByChannel[c][outOffset + i] += inData[inOffset + i] * window[i];
				}
			}
		}
	}

	outOffset += hopOut;
	inOffset += hopIn;

	while (outOffset + windowSize < workOutSamples && inOffset + windowSize < workEndIn) {
		let bestOffset = inOffset;
		const minSearch = Math.max(workStartIn, inOffset - searchRange);
		const maxSearch = Math.min(workEndIn - windowSize, inOffset + searchRange);

		if (maxSearch > minSearch) {
			let maxCorr = -Infinity;
			let bestDelta = 0;

			for (let testOffset = minSearch; testOffset <= maxSearch; testOffset += 4) {
				let corr = 0;
				for (let i = 0; i < hopOut; i += 4) {
					if (outOffset + i < workOutSamples && testOffset + i < workEndIn) {
						for (let c = 0; c < channels; c++) {
							const inData = inputChannels[c];
							if (inData) {
								corr +=
									workOutDataByChannel[c][outOffset + i] *
									inData[testOffset + i];
							}
						}
					}
				}
				if (corr > maxCorr) {
					maxCorr = corr;
					bestDelta = testOffset - inOffset;
				}
			}
			bestOffset = inOffset + bestDelta;
		}

		for (let i = 0; i < windowSize; i++) {
			if (bestOffset + i < workEndIn && outOffset + i < workOutSamples) {
				for (let c = 0; c < channels; c++) {
					const inData = inputChannels[c];
					if (inData) {
						workOutDataByChannel[c][outOffset + i] +=
							inData[bestOffset + i] * window[i];
					}
				}
			}
		}

		outOffset += hopOut;
		inOffset += hopIn;
	}

	for (let c = 0; c < channels; c++) {
		const finalData = outputChannels[c];
		const tempData = workOutDataByChannel[c];
		for (let i = 0; i < outSamples; i++) {
			const srcIdx = actualPaddingOutStart + i;
			if (srcIdx < workOutSamples) {
				finalData[i] = tempData[srcIdx];
			}
		}
	}

	return outputChannels;
}
