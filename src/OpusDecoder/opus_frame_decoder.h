#include <stdlib.h>
#include <opus.h>

OpusDecoder *opus_frame_decoder_create(int sample_rate, int channels);

int opus_frame_decode(OpusDecoder *decoder, const unsigned char *in, opus_int32 in_len, opus_int16 *out);

void opus_frame_decoder_destroy(OpusDecoder *st);
