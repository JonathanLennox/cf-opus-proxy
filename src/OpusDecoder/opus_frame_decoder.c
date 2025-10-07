#include <emscripten.h>
#include "opus_frame_decoder.h"
// Code adapted from wasm-audio-deocders https://eshaz.github.io/wasm-audio-decoders/
// "The source code that originates in this project is licensed under
// the MIT license. Please note that any external source code included
// by repository, such as the decoding libraries included as git
// submodules and compiled into the dist files, may have different
// licensing terms."

// out should be able to store frame_size*channels*sizeof(float) 
// frame_size should be the maximum packet duration (120ms; 5760 for 48kHz)
#define MAX_PACKET_DURATION_MS 5760

EMSCRIPTEN_KEEPALIVE
OpusFrameDecoder *opus_frame_decoder_create(int sample_rate, int channels) {
    OpusFrameDecoder decoder;
    decoder.channels = channels;
    decoder.errors = 0;
    
    decoder.st = opus_decoder_create(
      sample_rate, 
      channels, 
      &decoder.errors
    );

    OpusFrameDecoder *ptr = malloc(sizeof(decoder));
    *ptr = decoder;
    return ptr;
}

EMSCRIPTEN_KEEPALIVE
int opus_frame_decode(OpusFrameDecoder *decoder, const unsigned char *in, opus_int32 in_len, opus_int16 *out) {
    int samples_decoded = opus_decode(
      decoder->st, 
      in, 
      in_len, 
      out, 
      MAX_PACKET_DURATION_MS, 
      0 // disable forward error correction // TODO
    );
    
    return samples_decoded;
}

EMSCRIPTEN_KEEPALIVE
void opus_frame_decoder_destroy(OpusFrameDecoder *decoder) {
    if (decoder) {
        if (decoder->st) {
            opus_decoder_destroy(decoder->st);
        }
        free(decoder);
    }
}
