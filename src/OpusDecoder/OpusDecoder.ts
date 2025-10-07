// Code adapted from wasm-audio-deocders https://eshaz.github.io/wasm-audio-decoders/
// "The source code that originates in this project is licensed under
// the MIT license. Please note that any external source code included
// by repository, such as the decoding libraries included as git
// submodules and compiled into the dist files, may have different
// licensing terms."

import OpusDecoderModule from '../../dist/opus-decoder.js'
// @ts-ignore
import wasm from '../../dist/opus-decoder.wasm'

export type OpusDecoderDefaultSampleRate = 48000;
export type OpusDecoderSampleRate =
  | 8000
  | 12000
  | 16000
  | 24000
  | OpusDecoderDefaultSampleRate;

export interface DecodeError {
  message: string;
  frameLength: number;
  frameNumber: number;
  inputBytes: number;
  outputSamples: number;
}

export interface OpusDecodedAudio<
  SampleRate extends OpusDecoderSampleRate = OpusDecoderDefaultSampleRate,
> {
  pcmData: TypedArrayAllocation<Int16Array>;
  samplesDecoded: number;
  sampleRate: SampleRate;
  errors: DecodeError[];
  channels: number;
}

interface OpusWasmInstance {
  opus_frame_decoder_create: (sampleRate: number, channels: number) => number;
  opus_frame_decoder_destroy: (decoder: number) => void;
  opus_frame_decode: (decoder: number, inputPtr: number, inputLength: number, outputPtr: number) => number;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAP: ArrayBuffer;
  module: any;
}

interface TypedArrayAllocation<T extends Uint8Array | Int16Array> {
  ptr: number;
  len: number;
  buf: T;
}

type TypedArray = Uint8Array | Int16Array

type TypedArrayConstructor = Uint8ArrayConstructor | Int16ArrayConstructor;

export class OpusDecoder<
  SampleRate extends OpusDecoderSampleRate | undefined = undefined,
> {
  static errors = new Map([
    [-1, "OPUS_BAD_ARG: One or more invalid/out of range arguments"],
    [-2, "OPUS_BUFFER_TOO_SMALL: Not enough bytes allocated in the buffer"],
    [-3, "OPUS_INTERNAL_ERROR: An internal error was detected"],
    [-4, "OPUS_INVALID_PACKET: The compressed data passed is corrupted"],
    [-5, "OPUS_UNIMPLEMENTED: Invalid/unsupported request number"],
    [-6, "OPUS_INVALID_STATE: An encoder or decoder structure is invalid or already freed"],
    [-7, "OPUS_ALLOC_FAIL: Memory allocation has failed"],
  ]);

  static opusModule = new Promise<OpusWasmInstance>((resolve, reject) => {
      OpusDecoderModule({
        instantiateWasm(info: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
          let instance = new WebAssembly.Instance(wasm, info)
          receive(instance)
          return instance.exports
        }
      }).then((module: any) => {
          resolve({
              opus_frame_decoder_create: module._opus_frame_decoder_create,
              opus_frame_decoder_destroy: module._opus_frame_decoder_destroy,
              opus_frame_decode: module._opus_frame_decode,
              malloc: module._malloc,
              free: module._free,
              HEAPU8: module.HEAPU8,
              HEAP16: module.HEAP16,
              HEAP: module.wasmMemory.buffer,
              module
          })
      })
  })

  private _sampleRate: OpusDecoderSampleRate;
  private _channels: number;
  private _inputSize: number;
  private _outputChannelSize: number;
  private _inputBytes: number;
  private _outputSamples: number;
  private _frameNumber: number;
  private _pointers: Set<number>;
  private _ready: Promise<void>;
  private wasm!: OpusWasmInstance;
  private _input!: TypedArrayAllocation<Uint8Array>;
  private _output!: TypedArrayAllocation<Int16Array>;
  private _decoder!: number;

  constructor(options: {
    sampleRate?: SampleRate;
    channels?: number;
  } = {}) {

    const isNumber = (param: unknown): param is number => typeof param === "number";

    const { sampleRate, channels } = options;

    // libopus sample rate
    this._sampleRate = [8e3, 12e3, 16e3, 24e3, 48e3].includes(sampleRate as number)
      ? (sampleRate as OpusDecoderSampleRate)
      : 48000;

    // channel mapping family 0
    this._channels = isNumber(channels) ? channels : 2;

    this._inputSize = 32000 * 0.12 * this._channels; // 256kbs per channel
    this._outputChannelSize = 120 * 48; // 120 ms at 48 kHz

    this._inputBytes = 0;
    this._outputSamples = 0;
    this._frameNumber = 0;

    this._pointers = new Set();

    this._ready = this._init();
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  async _init(): Promise<void> {
    const wasmInstance = await OpusDecoder.opusModule;
    this.wasm = wasmInstance;

    this._input = this.allocateTypedArray(
      this._inputSize,
      Uint8Array
    );

    this._output = this.allocateTypedArray(
      this._channels * this._outputChannelSize,
      Int16Array
    );

    this._decoder = this.wasm.opus_frame_decoder_create(
      this._sampleRate,
      this._channels
    );
  }

  async reset(): Promise<void> {
    this.free();
    return this._init();
  }

  allocateTypedArray<T extends Uint8Array>(
    len: number,
    TypedArray: Uint8ArrayConstructor,
    setPointer?: boolean
  ): TypedArrayAllocation<T>;
  allocateTypedArray<T extends Int16Array>(
    len: number,
    TypedArray: Int16ArrayConstructor,
    setPointer?: boolean
  ): TypedArrayAllocation<T>;
  allocateTypedArray<T extends Uint8Array | Int16Array>(
    len: number,
    TypedArray: TypedArrayConstructor,
    setPointer: boolean = true
  ): TypedArrayAllocation<T> {
    const ptr = this.wasm.malloc(TypedArray.BYTES_PER_ELEMENT * len);
    if (setPointer) this._pointers.add(ptr);

    return {
      ptr: ptr,
      len: len,
      buf: new TypedArray(this.wasm.HEAP, ptr, len) as T,
    };
  }


  free(): void {
    this._pointers.forEach((ptr) => {
      this.wasm.free(ptr);
    });
    this._pointers.clear();

    this.wasm.opus_frame_decoder_destroy(this._decoder);
    this.wasm.free(this._decoder);
  }

  _decode(opusFrame: Uint8Array): {
    outputBuffer: TypedArrayAllocation<Int16Array>;
    samplesDecoded: number;
    error?: string;
  } {
    if (!(opusFrame instanceof Uint8Array)) {
      throw new Error(
        `Data to decode must be Uint8Array. Instead got ${typeof opusFrame}`
      );
    }

    this._input.buf.set(opusFrame);

    let samplesDecoded = this.wasm.opus_frame_decode(
      this._decoder,
      this._input.ptr,
      opusFrame.length,
      this._output.ptr
    );

    let error: string | undefined;

    if (samplesDecoded < 0) {
      error = `libopus ${samplesDecoded} ${OpusDecoder.errors.get(samplesDecoded) || "Unknown Error" }`;

      console.error(error);
      samplesDecoded = 0;
    }

    return {
      outputBuffer: this._output,
      samplesDecoded,
      error,
    };
  }

  addError(
    errors: DecodeError[],
    message: string,
    frameLength: number,
    frameNumber: number,
    inputBytes: number,
    outputSamples: number,
  ): void {
    errors.push({
      message: message,
      frameLength: frameLength,
      frameNumber: frameNumber,
      inputBytes: inputBytes,
      outputSamples: outputSamples,
    });
  }

  getDecodedAudio<SR extends OpusDecoderSampleRate>(
    errors: DecodeError[],
    pcmData: TypedArrayAllocation<Int16Array>,
    channels: number,
    samplesDecoded: number,
    sampleRate: SR,
  ): OpusDecodedAudio<SR> {
    return {
      errors,
      pcmData,
      channels,
      samplesDecoded,
      sampleRate,
    }
  }

  decodeFrame(
    opusFrame: Uint8Array
  ): OpusDecodedAudio<
    SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate
  > {
    const errors: DecodeError[] = [];

    const decoded = this._decode(opusFrame);

    if (decoded.error) {
      this.addError(
        errors,
        decoded.error,
        opusFrame.length,
        this._frameNumber,
        this._inputBytes,
        this._outputSamples
      );
    }

    this._frameNumber++;
    this._inputBytes += opusFrame.length;
    this._outputSamples += decoded.samplesDecoded;

    return this.getDecodedAudio(
      errors,
      decoded.outputBuffer,
      this._channels,
      decoded.samplesDecoded,
      this._sampleRate
    ) as OpusDecodedAudio<
      SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate
    >;
  }

  /* TODO */
  /*
  decodeFrames(opusFrames: Uint8Array[]): OpusDecodedAudio<
    SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate
  > {
    const outputBuffers: TypedArrayAllocation<Int16Array>[] = [];
    const errors: DecodeError[] = [];
    let samplesDecoded = 0;

    for (const opusFrame of opusFrames) {
      const decoded = this._decode(opusFrame);

      outputBuffers.push(decoded.outputBuffer);
      samplesDecoded += decoded.samplesDecoded;

      if (decoded.error) {
        this._common.addError(
          errors,
          decoded.error,
          opusFrame.length,
          this._frameNumber,
          this._inputBytes,
          this._outputSamples
        );
      }

      this._frameNumber++;
      this._inputBytes += opusFrame.length;
      this._outputSamples += decoded.samplesDecoded;
    }

    return this._WASMAudioDecoderCommon.getDecodedAudioMultiChannel(
      errors,
      outputBuffers,
      this._outputChannels,
      samplesDecoded,
      this._sampleRate
    );
  } */
}
