import { OpusDecoder } from './OpusDecoder/OpusDecoder';

// Type definition augmentation for Uint8Array - Cloudflare Worker's JS has these methods but TypeScript doesn't have
// declarations for them as of version 5.9.3.
// These definitions are taken from https://github.com/microsoft/TypeScript/pull/61696, which should be included
// in TypeScript 6.0 and later.
declare global {
	interface Uint8ArrayConstructor {
		/**
		 * Creates a new `Uint8Array` from a base64-encoded string.
		 * @param string The base64-encoded string.
		 * @param options If provided, specifies the alphabet and handling of the last chunk.
		 * @returns A new `Uint8Array` instance.
		 * @throws {SyntaxError} If the input string contains characters outside the specified alphabet, or if the last
		 * chunk is inconsistent with the `lastChunkHandling` option.
		 */
		fromBase64(
			string: string,
			options?: {
				alphabet?: "base64" | "base64url" | undefined;
				lastChunkHandling?: "loose" | "strict" | "stop-before-partial" | undefined;
			},
		): Uint8Array<ArrayBuffer>;
	}

	interface Uint8Array<TArrayBuffer extends ArrayBufferLike> {
		/**
		 * Converts the `Uint8Array` to a base64-encoded string.
		 * @param options If provided, sets the alphabet and padding behavior used.
		 * @returns A base64-encoded string.
		 */
		toBase64(
			options?: {
				alphabet?: "base64" | "base64url" | undefined;
				omitPadding?: boolean | undefined;
			},
		): string;
	}
}

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

export class OutgoingConnection {
	private _tag: string;
	public get tag() {
		return this._tag
	}
	private pendingTags: string[] = [];
	private connectionStatus: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private opusDecoder?: OpusDecoder<24000>;
	private openaiWebSocket?: WebSocket;
	private pendingOpusFrames: Uint8Array[] = [];
	private pendingAudioData: string[] = [];

	private _lastMediaTime: number = -1;
	public get lastMediaTime() {
		return this._lastMediaTime;
	}

	private lastTranscriptTime?: number = undefined

	onCompleteTranscription?: ((message: string) => void) = undefined
	onClosed?: ((tag: string) => void) = undefined

	constructor(tag: string, env: Env) {
		this._tag = tag;

		this.initializeOpusDecoder();
		this.initializeOpenAIWebSocket(env);
	}

	reset(newTag: string) {
		if (this.connectionStatus == 'connected') {
			this.pendingTags.push(newTag);
			const clearMessage = { type: "input_audio_buffer.clear" };
			this.openaiWebSocket?.send(JSON.stringify(clearMessage));
		} else {
			this._tag = newTag;
		}
		this.decoderStatus = 'pending';
		this.opusDecoder?.reset().then(() => {
			this.decoderStatus = 'ready';
			console.log(`Opus decoder reset for tag: ${this._tag}`);
			this.processPendingOpusFrames();
		});
	}

	private async initializeOpusDecoder(): Promise<void> {
		try {
			console.log(`Creating Opus decoder for tag: ${this._tag}`);
			this.opusDecoder = new OpusDecoder({
				sampleRate: 24000,
				channels: 1
			});

			await this.opusDecoder.ready;
			this.decoderStatus = 'ready';
			console.log(`Opus decoder ready for tag: ${this._tag}`);
			this.processPendingOpusFrames();
		} catch (error) {
			console.error(`Failed to create Opus decoder for tag ${this._tag}:`, error);
			this.decoderStatus = 'failed';
		}
	}

	private initializeOpenAIWebSocket(env: Env): void {
		try {
			const openaiWs = new WebSocket(OPENAI_WS_URL, [
				'realtime',
				`openai-insecure-api-key.${env.OPENAI_API_KEY}`
				]
			);

			console.log(`Opening OpenAI WebSocket to ${OPENAI_WS_URL} for tag: ${this._tag}`);

			this.openaiWebSocket = openaiWs;

			openaiWs.addEventListener('open', () => {
				console.log(`OpenAI WebSocket connected for tag: ${this._tag}`);
				this.connectionStatus = 'connected';

				const sessionConfig = {
					type: 'session.update',
					session: {
						type: "transcription",
						audio: {
							input: {
								format: {
									type: "audio/pcm",
									rate: 24000
								},
								noise_reduction: {
									type: "near_field"
								},
								transcription: {
									model: 'gpt-4o-transcribe',
									language: 'en' // TODO parameterize this
								},
								turn_detection: {
									type: 'server_vad',
									threshold: 0.5,
									prefix_padding_ms: 300,
									silence_duration_ms: 500
								}
							}
						}
					}
				};

				const configMessage = JSON.stringify(sessionConfig);
				console.log(`Initializing OpenAI config with message: ${configMessage}`)

				openaiWs.send(configMessage);

				// Process any pending audio data that was queued while waiting for connection
				this.processPendingAudioData();
			});

			openaiWs.addEventListener('message', (event) => {
				this.handleOpenAIMessage(event.data);
			});

			openaiWs.addEventListener('error', (error) => {
				console.error(`OpenAI WebSocket error for tag ${this._tag}:`, error);
				this.doClose(true);
				this.connectionStatus = 'failed';
			});

			openaiWs.addEventListener('close', () => {
				console.log(`OpenAI WebSocket closed for tag: ${this._tag}`);
				this.doClose(true);
				this.connectionStatus = 'failed';
			});

		} catch (error) {
			console.error(`Failed to create OpenAI WebSocket connection for tag ${this._tag}:`, error);
			this.connectionStatus = 'failed';
		}
	}

	handleMediaEvent(mediaEvent: any): void {
		// console.log(`Handling media event for tag: ${this.tag}`);

		if (mediaEvent.media?.payload === undefined) {
			console.warn(`No media payload in event for tag: ${this._tag}`);
			return;
		}

		try {
			this._lastMediaTime = Date.now();

			// Base64 decode the media payload to binary
			const opusFrame = Uint8Array.fromBase64(mediaEvent.media.payload);

			if (this.decoderStatus === 'ready' && this.opusDecoder) {
				this.processOpusFrame(opusFrame);
			} else if (this.decoderStatus === 'pending') {
				// Queue the binary data until decoder is ready
				this.pendingOpusFrames.push(opusFrame);
				// console.log(`Queued opus frame for tag: ${this.tag} (queue size: ${this.pendingOpusFrames.length})`);
			} else {
				console.log(`Not queueing opus frame for tag: ${this._tag}: decoder ${this.decoderStatus}`)
			}
		} catch (error) {
			console.error(`Failed to decode base64 media payload for tag ${this._tag}:`, error);
		}
	}

	private processOpusFrame(binaryData: Uint8Array): void {
		if (!this.opusDecoder) {
			console.error(`No opus decoder available for tag: ${this._tag}`);
			return;
		}

		try {
			// Decode the Opus audio data
			const decodedAudio = this.opusDecoder.decodeFrame(binaryData)

			// Base64 encode the decoded audio - need to convert Int16Array to Uint8Array correctly
			const int16Data = decodedAudio.pcmData.buf.subarray(0, decodedAudio.samplesDecoded);
			const uint8Data = new Uint8Array(int16Data.buffer, int16Data.byteOffset, decodedAudio.samplesDecoded * 2);
			const encodedAudio = uint8Data.toBase64();

			if (this.connectionStatus === 'connected' && this.openaiWebSocket) {
				this.sendAudioToOpenAI(encodedAudio);
			} else if (this.connectionStatus === 'pending') {
				// Queue the audio data for later sending
				this.pendingAudioData.push(encodedAudio);
				// console.log(`Queued audio data for tag: ${this.tag} (queue size: ${this.pendingAudioData.length})`);
			} else {
				console.log(`Not queueing audio data for tag: ${this._tag}: connection ${this.connectionStatus}`)
			}

		} catch (error) {
			console.error(`Error processing audio data for tag ${this._tag}:`, error);
		}
	}

	private processPendingOpusFrames(): void {
		if (this.pendingOpusFrames.length === 0) {
			return;
		}

		console.log(`Processing ${this.pendingOpusFrames.length} queued media payloads for tag: ${this._tag}`);

		// Process all queued media payloads
		const queuedPayloads = [...this.pendingOpusFrames];
		this.pendingOpusFrames = []; // Clear the queue

		for (const binaryData of queuedPayloads) {
			this.processOpusFrame(binaryData);
		}
	}

	private sendAudioToOpenAI(encodedAudio: string): void {
		if (!this.openaiWebSocket) {
			console.error(`No websocket available for for tag: ${this._tag}`);
			return;
		}

		try {
			const audioMessage = {
				type: 'input_audio_buffer.append',
				audio: encodedAudio,
			};
			const audioMessageString = JSON.stringify(audioMessage);

			this.openaiWebSocket.send(audioMessageString);
		} catch (error) {
			console.error(`Failed to send audio to OpenAI for tag ${this._tag}`, error);
		}
	}

	private processPendingAudioData(): void {
		if (this.pendingAudioData.length === 0) {
			return;
		}

		console.log(`Processing ${this.pendingAudioData.length} queued audio data for tag: ${this._tag}`);

		// Process all queued audio data
		const queuedAudio = [...this.pendingAudioData];
		this.pendingAudioData = []; // Clear the queue

		for (const encodedAudio of queuedAudio) {
			this.sendAudioToOpenAI(encodedAudio);
		}
	}

	private async handleOpenAIMessage(data: any): Promise<void> {
		let parsedMessage;
		try {
			parsedMessage = JSON.parse(data);
		} catch (parseError) {
			console.error(`Failed to parse OpenAI message as JSON for tag ${this._tag}:`, parseError);
			// TODO: close this connection?
			return;
		}
		if (parsedMessage.type === "conversation.item.input_audio_transcription.completed") {
			if (this.lastTranscriptTime !== undefined) {
				this.lastTranscriptTime = Date.now();
			}
			// TODO: some use cases will want to receive the audio transcription deltas also
		}
		if (parsedMessage.type === "conversation.item.input_audio_transcription.completed") {
			let transcriptTime;
			if (this.lastTranscriptTime !== undefined) {
				transcriptTime = this.lastTranscriptTime
				this.lastTranscriptTime	= undefined
			} else {
				transcriptTime = Date.now();
			}
			this.onCompleteTranscription?.(JSON.stringify({ tag: this._tag, time: transcriptTime, transcript: parsedMessage.transcript }));
		} else if (parsedMessage.type === "input_audio_buffer.cleared") {
			// Reset completed
			this._tag = this.pendingTags.shift()!
		} else if (parsedMessage.type === "error") {
			console.error(`OpenAI sent error message for ${this._tag}: ${parsedMessage}`);
			this.doClose(true);
		}
		// TODO: are there any other messages we care about?
	}

	close(): void {
		this.doClose(false);
	}

	private doClose(notify: boolean): void {
		this.opusDecoder?.free()
		this.openaiWebSocket?.close()
		this.decoderStatus = 'closed';
		this.connectionStatus = 'closed';
		if (notify) {
			this.onClosed?.(this._tag);
		}
	}
}
