import { stretchChannelDataWsola } from "./audioTimeStretch";

export interface AudioTimeStretchWorkerRequest {
	requestId: number;
	inputChannels: Float32Array[];
	sampleRate: number;
	speed: number;
	sourceOffsetSec: number;
	sourceDurationSec: number;
	audibleDurationSec: number;
}

export interface AudioTimeStretchWorkerResponse {
	requestId: number;
	outputChannels?: Float32Array[];
	error?: string;
}

self.onmessage = (event: MessageEvent<AudioTimeStretchWorkerRequest>) => {
	const {
		requestId,
		inputChannels,
		sampleRate,
		speed,
		sourceOffsetSec,
		sourceDurationSec,
		audibleDurationSec,
	} = event.data;

	try {
		const outputChannels = stretchChannelDataWsola({
			inputChannels,
			sampleRate,
			speed,
			sourceOffsetSec,
			sourceDurationSec,
			audibleDurationSec,
		});

		const response: AudioTimeStretchWorkerResponse = {
			requestId,
			outputChannels,
		};
		(self as unknown as Worker).postMessage(
			response,
			outputChannels.map((ch) => ch.buffer),
		);
	} catch (error) {
		const response: AudioTimeStretchWorkerResponse = {
			requestId,
			error: error instanceof Error ? error.message : String(error),
		};
		(self as unknown as Worker).postMessage(response);
	}
};
