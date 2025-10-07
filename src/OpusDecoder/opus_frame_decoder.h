#include <stdlib.h>
#include <opus.h>

typedef struct {
    int channels;
    int errors;
    OpusDecoder *st;
} OpusFrameDecoder;

OpusFrameDecoder *opus_frame_decoder_create(int sample_rate, int channels);

int opus_frame_decode(OpusFrameDecoder *decoder, const unsigned char *in, opus_int32 in_len, opus_int16 *out);

void opus_frame_decoder_destroy(OpusFrameDecoder *st);
