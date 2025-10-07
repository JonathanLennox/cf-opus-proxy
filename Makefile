
default: dist

OPUS_DECODER_SRC=src/OpusDecoder
OPUS_DECODER_BUILD=./build
OPUS_DECODER_DIST=./dist

OPUS_DECODER_EMSCRIPTEN_BUILD=$(OPUS_DECODER_BUILD)/EmscriptenWasm.tmp.js
OPUS_DECODER_EMSCRIPTEN_WASM=$(OPUS_DECODER_BUILD)/EmscriptenWasm.tmp.wasm
OPUS_DECODER_MODULE=$(OPUS_DECODER_DIST)/opus-decoder.js
OPUS_DECODER_WASM=$(OPUS_DECODER_DIST)/opus-decoder.wasm

LIBOPUS_SRC=$(OPUS_DECODER_SRC)/opus
LIBOPUS_BUILD=$(OPUS_DECODER_BUILD)/build-opus-wasm
LIBOPUS_WASM_LIB=$(OPUS_DECODER_BUILD)/libopus.a

clean:
	rm -rf $(OPUS_DECODER_EMSCRIPTEN_BUILD) $(OPUS_DECODER_EMSCRIPTEN_WASM) $(OPUS_DECODER_MODULE) $(OPUS_DECODER_WASM) $(LIBOPUS_WASM_LIB)
	+emmake $(MAKE) -C $(LIBOPUS_BUILD) clean

configure: libopus-configure

dist: opus-decoder
distclean: clean
	rm -rf $(OPUS_DECODER_BUILD) $(OPUS_DECODER_DIST)

# opus-decoder

opus-decoder: opus-wasmlib $(OPUS_DECODER_EMSCRIPTEN_BUILD)
	mkdir -p $(OPUS_DECODER_DIST)
	cp $(OPUS_DECODER_EMSCRIPTEN_BUILD) $(OPUS_DECODER_MODULE)
	@if [ -f "$(OPUS_DECODER_EMSCRIPTEN_WASM)" ]; then \
		cp $(OPUS_DECODER_EMSCRIPTEN_WASM) $(OPUS_DECODER_WASM); \
		echo "Copied WASM file to $(OPUS_DECODER_WASM)"; \
	else \
		echo "Warning: WASM file not found, you may need to adjust emscripten settings"; \
	fi

# libopus
opus-wasmlib: $(LIBOPUS_WASM_LIB)

# common EMCC options
define EMCC_OPTS
-O2 \
-msimd128 \
--minify 0 \
-s WASM=1 \
-s TEXTDECODER=2 \
-s SINGLE_FILE=0 \
-s MALLOC="emmalloc" \
-s NO_FILESYSTEM=1 \
-s ENVIRONMENT=web \
-s ASSERTIONS=1 \
-s ABORTING_MALLOC=0 \
-s EXIT_RUNTIME=0 \
-s MODULARIZE=1 \
-s DYNAMIC_EXECUTION=0 \
-s EXPORT_NAME="OpusDecoderModule"
endef

# ------------------
# opus-decoder
# ------------------
define OPUS_DECODER_EMCC_OPTS
-s INITIAL_MEMORY=28MB \
-s EXPORTED_FUNCTIONS="[ \
    '_free', '_malloc' \
  , '_opus_frame_decoder_destroy' \
  , '_opus_frame_decode' \
  , '_opus_frame_decoder_create' \
]" \
-s EXPORTED_RUNTIME_METHODS="['wasmMemory']" \
-I "$(LIBOPUS_SRC)/include" \
$(OPUS_DECODER_SRC)/opus_frame_decoder.c
endef

$(OPUS_DECODER_EMSCRIPTEN_BUILD): $(LIBOPUS_WASM_LIB)
	mkdir -p $(OPUS_DECODER_BUILD)
	@ echo "Building Emscripten WebAssembly module $(OPUS_DECODER_EMSCRIPTEN_BUILD)..."
	emcc \
		-o "$(OPUS_DECODER_EMSCRIPTEN_BUILD)" \
	  ${EMCC_OPTS} \
	  $(OPUS_DECODER_EMCC_OPTS) \
	  $(LIBOPUS_WASM_LIB)
	@ echo "+-------------------------------------------------------------------------------"
	@ echo "|"
	@ echo "|  Successfully built JS Module: $(OPUS_DECODER_EMSCRIPTEN_BUILD)"
	@ echo "|"
	@ echo "+-------------------------------------------------------------------------------"


$(LIBOPUS_WASM_LIB): $(LIBOPUS_BUILD)/Makefile
	@ echo "Building Opus Emscripten Library $(LIBOPUS_WASM_LIB)..."
	+emmake $(MAKE) -C $(LIBOPUS_BUILD) libopus.la -r
	cp ${LIBOPUS_BUILD}/.libs/libopus.a $(LIBOPUS_WASM_LIB)
	@ echo "+-------------------------------------------------------------------------------"
	@ echo "|"
	@ echo "|  Successfully built: $(LIBOPUS_WASM_LIB)"
	@ echo "|"
	@ echo "+-------------------------------------------------------------------------------"

libopus-configure: $(LIBOPUS_BUILD)/Makefile

 $(LIBOPUS_BUILD)/Makefile: $(LIBOPUS_SRC)/configure
	mkdir -p $(LIBOPUS_BUILD)
	cd $(LIBOPUS_BUILD); CFLAGS="-O3 -msimd128" emconfigure $(CURDIR)/$(LIBOPUS_SRC)/configure \
	  --host=wasm32-unknown-emscripten \
	  --enable-float-approx \
	  --disable-rtcd \
	  --disable-hardening \
	  --disable-shared
	cd $(LIBOPUS_BUILD); rm -f a.wasm

$(LIBOPUS_SRC)/configure: $(LIBOPUS_SRC)/configure.ac
	cd $(LIBOPUS_SRC); ./autogen.sh
