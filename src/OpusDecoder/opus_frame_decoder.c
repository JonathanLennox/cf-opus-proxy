#include <emscripten.h>
#include <assert.h>
#include <stdlib.h>
#include "opus_frame_decoder.h"
// Code adapted from wasm-audio-decoders https://eshaz.github.io/wasm-audio-decoders/
// "The source code that originates in this project is licensed under
// the MIT license. Please note that any external source code included
// by repository, such as the decoding libraries included as git
// submodules and compiled into the dist files, may have different
// licensing terms."

// out should be able to store frame_size*channels*sizeof(opus_int16)
// frame_size should be the maximum packet duration (120ms; 5760 for 48kHz)
#define MAX_PACKET_DURATION_SAMPLES 5760

EMSCRIPTEN_KEEPALIVE
OpusDecoder *opus_frame_decoder_create(int sample_rate, int channels) {
    OpusDecoder* decoder;
    int error = 0;

    decoder = opus_decoder_create(
      sample_rate,
      channels,
      &error
    );

    if (decoder == NULL) {
        assert(error < 0);
        return (OpusDecoder*)error; // emscripten pointers will always be positive
    }

    return decoder;
}

EMSCRIPTEN_KEEPALIVE
int opus_frame_decode(OpusDecoder *decoder, const unsigned char *in, opus_int32 in_len, opus_int16 *out) {
    int samples_decoded = opus_decode(
      decoder,
      in,
      in_len,
      out,
      MAX_PACKET_DURATION_SAMPLES,
      0 // disable forward error correction // TODO
    );
    
    return samples_decoded;
}

EMSCRIPTEN_KEEPALIVE
void opus_frame_decoder_reset(OpusDecoder *decoder) {
    if (decoder) {
      opus_decoder_ctl(decoder, OPUS_RESET_STATE);
    }
}

EMSCRIPTEN_KEEPALIVE
void opus_frame_decoder_destroy(OpusDecoder *decoder) {
    if (decoder) {
      opus_decoder_destroy(decoder);
    }
}
