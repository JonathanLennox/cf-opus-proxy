import { OpusDecoder } from './OpusDecoder/OpusDecoder';
import { TranscriberProxy } from './transcriberproxy';

// Type definition augmentation for Uint8Array polyfills
declare global {
	interface Uint8ArrayConstructor {
		fromBase64(base64String: string): Uint8Array;
	}
	interface Uint8Array {
		toBase64(): string;
	}
}

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

export class OutgoingConnection {
	private tag: string;
	private connectionStatus: 'pending' | 'connected' | 'failed' | 'closed';
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'closed';
	private opusDecoder?: OpusDecoder<24000>;
	private openaiWebSocket?: WebSocket;
	private pendingOpusFrames: Uint8Array[] = [];
	private pendingAudioData: string[] = [];

	onCompleteTranscription?: ((message: string) => void) = undefined
	onClosed?: ((tag: string) => void) = undefined

	constructor(tag: string, env: any) {
		this.tag = tag;
		this.connectionStatus = 'pending';
		this.decoderStatus = 'pending';

		this.initializeOpusDecoder();
		this.initializeOpenAIWebSocket(env);
	}

	private async initializeOpusDecoder(): Promise<void> {
		try {
			console.log(`Creating Opus decoder for tag: ${this.tag}`);
			this.opusDecoder = new OpusDecoder({
				sampleRate: 24000,
				channels: 1
			});

			await this.opusDecoder.ready;
			this.decoderStatus = 'ready';
			console.log(`Opus decoder ready for tag: ${this.tag}`);
			this.processPendingOpusFrames();
		} catch (error) {
			console.error(`Failed to create Opus decoder for tag ${this.tag}:`, error);
			this.decoderStatus = 'failed';
		}
	}

	private initializeOpenAIWebSocket(env: any): void {
		try {
			const openaiWs = new WebSocket(OPENAI_WS_URL, [
				'realtime',
				`openai-insecure-api-key.${env.OPENAI_API_KEY}`,
				'openai-beta.realtime-v1'
			]
			);

			console.log(`Opening OpenAI WebSocket to ${OPENAI_WS_URL} for tag: ${this.tag}`);

			this.openaiWebSocket = openaiWs;

			openaiWs.addEventListener('open', () => {
				console.log(`OpenAI WebSocket connected for tag: ${this.tag}`);
				this.connectionStatus = 'connected';

				const sessionConfig = {
					type: 'transcription_session.update',
					session: {
						input_audio_format: 'pcm16',
						input_audio_transcription: {
							model: 'gpt-4o-transcribe',
							language: 'en'
						},
						turn_detection: {
							type: 'server_vad',
							threshold: 0.5,
							prefix_padding_ms: 300,
							silence_duration_ms: 500
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
				console.error(`OpenAI WebSocket error for tag ${this.tag}:`, error);
				this.close();
				this.connectionStatus = 'failed';
			});

			openaiWs.addEventListener('close', () => {
				console.log(`OpenAI WebSocket closed for tag: ${this.tag}`);
				this.close();
				this.connectionStatus = 'failed';
			});

		} catch (error) {
			console.error(`Failed to create OpenAI WebSocket connection for tag ${this.tag}:`, error);
			this.connectionStatus = 'failed';
		}
	}

	handleMediaEvent(mediaEvent: any): void {
		// console.log(`Handling media event for tag: ${this.tag}`);

		if (mediaEvent.media?.payload === undefined) {
			console.warn(`No media payload in event for tag: ${this.tag}`);
			return;
		}

		try {
			// Base64 decode the media payload to binary
			const opusFrame = Uint8Array.fromBase64(mediaEvent.media.payload);

			if (this.decoderStatus === 'ready' && this.opusDecoder) {
				this.processOpusFrame(opusFrame);
			} else if (this.decoderStatus === 'pending') {
				// Queue the binary data until decoder is ready
				this.pendingOpusFrames.push(opusFrame);
				// console.log(`Queued opus frame for tag: ${this.tag} (queue size: ${this.pendingOpusFrames.length})`);
			} else {
				console.log(`Not queueing opus frame for tag: ${this.tag}: decoder ${this.decoderStatus}`)
			}
		} catch (error) {
			console.error(`Failed to decode base64 media payload for tag ${this.tag}:`, error);
		}
	}

	// Polyfills for Uint8Array base64 methods if not available
	static {
		if (!Uint8Array.fromBase64) {
			Uint8Array.fromBase64 = function (base64: string): Uint8Array {
				const binaryString = atob(base64);
				const bytes = new Uint8Array(binaryString.length);
				for (let i = 0; i < binaryString.length; i++) {
					bytes[i] = binaryString.charCodeAt(i);
				}
				return bytes;
			};
		}

		if (!Uint8Array.prototype.toBase64) {
			Uint8Array.prototype.toBase64 = function (): string {
				let binaryString = '';
				for (let i = 0; i < this.length; i++) {
					binaryString += String.fromCharCode(this[i]);
				}
				return btoa(binaryString);
			};
		}
	}

	private processOpusFrame(binaryData: Uint8Array): void {
		if (!this.opusDecoder) {
			console.error(`No opus decoder available for tag: ${this.tag}`);
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
				console.log(`Not queueing audio data for tag: ${this.tag}: connection ${this.connectionStatus}`)
			}

		} catch (error) {
			console.error(`Error processing audio data for tag ${this.tag}:`, error);
		}
	}

	private processPendingOpusFrames(): void {
		if (this.pendingOpusFrames.length === 0) {
			return;
		}

		console.log(`Processing ${this.pendingOpusFrames.length} queued media payloads for tag: ${this.tag}`);

		// Process all queued media payloads
		const queuedPayloads = [...this.pendingOpusFrames];
		this.pendingOpusFrames = []; // Clear the queue

		for (const binaryData of queuedPayloads) {
			this.processOpusFrame(binaryData);
		}
	}

	private sendAudioToOpenAI(encodedAudio: string): void {
		if (!this.openaiWebSocket) {
			console.error(`No websocket available for for tag: ${this.tag}`);
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
			console.error(`Failed to send audio to OpenAI for tag ${this.tag}`, error);
		}
	}

	private processPendingAudioData(): void {
		if (this.pendingAudioData.length === 0) {
			return;
		}

		console.log(`Processing ${this.pendingAudioData.length} queued audio data for tag: ${this.tag}`);

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
			console.error(`Failed to parse OpenAI message as JSON for tag ${this.tag}:`, parseError);
			// TODO: close this connection?
			return;
		}

		if (parsedMessage.type === "conversation.item.input_audio_transcription.completed") {
			this.onCompleteTranscription?.(JSON.stringify({ tag: this.tag, transcript: parsedMessage.transcript }));

			// TODO: some use cases will want the audio transcription deltas also, and maybe other messages
		} else if (parsedMessage.type === "error") {
			this.close();
		}
	}

	private close(): void {
		this.opusDecoder?.free()
		this.openaiWebSocket?.close()
		this.decoderStatus = 'closed';
		this.connectionStatus = 'closed';
		this.onClosed?.(this.tag);
	}
}
