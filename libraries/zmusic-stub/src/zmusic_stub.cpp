// ZMusic stub for the UZDoom WASM build.
//
// This translation unit replaces the real libzmusic with a minimal,
// WASM-friendly implementation:
//
//   • Sound-effect decoder  — real WAV + OGG Vorbis (stb_vorbis). Needed
//     because Brutal Doom (and many other mods) ship compressed SFX in
//     their PK3s; a null SoundDecoder is total silence.
//
//   • Music player          — real MUS / MIDI via TinySoundFont (+ a small
//     inline mus2mid converter), and OGG Vorbis via stb_vorbis. If no
//     SoundFont has been supplied at /soundfont.sf2, MIDI is silenced
//     gracefully (engine keeps running). OGG music still works either way.
//
// When a real WASM build of libzmusic is available, drop this stub and
// link libzmusic.a instead.
//
// Thread model: oalsound.cpp spins the mixer thread that calls FillStream
// on us. The engine guarantees only one music stream is active at a time
// and only one thread pokes it at a time, so we don't need locking inside
// a given stream.

#include "zmusic.h"

#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <new>

// TSF / TML (single-header; implementations live in tsf_impl.c).
// The headers themselves are extern-C-guarded and safe to include from C++.
#include "tsf/tsf.h"
#include "tsf/tml.h"

// --- stb_vorbis API (implementation lives in stb_vorbis_impl.c) ----------
extern "C" {
    typedef struct stb_vorbis stb_vorbis;
    typedef struct {
        unsigned int sample_rate;
        int channels;
        unsigned int setup_memory_required;
        unsigned int setup_temp_memory_required;
        unsigned int temp_memory_required;
        int max_frame_size;
    } stb_vorbis_info;
    typedef struct { char* alloc_buffer; int alloc_buffer_length_in_bytes; } stb_vorbis_alloc;

    stb_vorbis* stb_vorbis_open_memory(const unsigned char* data, int len,
                                       int* error, const stb_vorbis_alloc* alloc);
    stb_vorbis_info stb_vorbis_get_info(stb_vorbis* f);
    int stb_vorbis_get_samples_short_interleaved(stb_vorbis* f, int channels,
                                                 short* buffer, int num_shorts);
    int stb_vorbis_get_samples_float_interleaved(stb_vorbis* f, int channels,
                                                 float* buffer, int num_floats);
    int stb_vorbis_seek_start(stb_vorbis* f);
    void stb_vorbis_close(stb_vorbis* f);
}

// --- error reporting -----------------------------------------------------
static const char* g_last_error = "";
extern "C" const char* ZMusic_GetLastError() {
    return (g_last_error && *g_last_error) ? g_last_error
        : "ZMusic stub (WASM build)";
}

// --- callbacks / preload -------------------------------------------------
extern "C" void ZMusic_SetCallbacks(const ZMusicCallbacks*) {}
extern "C" void ZMusic_SetGenMidi(const uint8_t*) {}
extern "C" void ZMusic_SetWgOpn(const void*, unsigned) {}
extern "C" void ZMusic_SetDmxGus(const void*, unsigned) {}

// --- configuration -------------------------------------------------------
static const ZMusicConfigurationSetting kNoConfig = { nullptr, 0, (ZMusicVariableType)0, 0, nullptr };
extern "C" const ZMusicConfigurationSetting* ZMusic_GetConfiguration() { return &kNoConfig; }

// --- MIDI identification / source (dumper path — unused in-game) --------
extern "C" EMIDIType ZMusic_IdentifyMIDIType(uint32_t*, int) { return MIDI_NOTMIDI; }
extern "C" ZMusic_MidiSource ZMusic_CreateMIDISource(const uint8_t*, size_t, EMIDIType) { return nullptr; }
extern "C" zmusic_bool ZMusic_MIDIDumpWave(ZMusic_MidiSource, EMidiDevice, const char*, const char*, int, int) { return 0; }
extern "C" zmusic_bool ZMusic_WriteSMF(ZMusic_MidiSource, const char*, int) { return 0; }

// ==========================================================================
// Music player: TSF (MIDI) + stb_vorbis (OGG)
// ==========================================================================
//
// We output stereo float32 @ 44100 Hz. Engine-facing SoundStreamInfo reports
// mNumChannels = +2 (positive = floats), which is what the music glue in
// src/common/audio/music/music.cpp prefers (it volume-scales floats directly,
// no int->float conversion hop).

namespace {

constexpr int kSampleRate = 44100;
constexpr int kChannels   = 2;
// 32 KB of stereo float32 = 4096 frames = ~92 ms per AL buffer. With
// oalsound.cpp's 8-deep queue under Emscripten that's ~740 ms of headroom,
// enough to absorb GL upload / GC hitches without underrunning.
constexpr int kBufBytes   = 32768;
// TSF global output headroom: busy MUS tracks can peak above ±1.0 (observed
// ~1.38 on D_INTRO). Attenuating TSF's master output ~3 dB avoids hard-clip
// crackle in the float→int16 converter. Engine-side snd_musicvolume still
// scales on top of this via music.cpp::FillStream.
constexpr float kTsfGainDb = -3.0f;

enum MusicKind : uint8_t { MK_None = 0, MK_Midi = 1, MK_Ogg = 2 };

struct MusicImpl {
    MusicKind kind;
    bool      looping;
    bool      paused;
    bool      ended;

    // For MIDI: the TSF synth (one per stream, shares the global SoundFont
    // via tsf_copy). cur_ms advances as we render; cursor walks the event
    // list in lock-step with cur_ms.
    tsf*         synth;
    tml_message* events_head;   // to free
    tml_message* cursor;        // next event to dispatch
    double       cur_ms;
    unsigned int total_ms;      // length for loop rewind detection

    // For OGG: stb_vorbis + the backing memory it aliases.
    stb_vorbis* ogg;
    uint8_t*    ogg_data;       // we own; stb_vorbis holds a pointer into it
    int         ogg_channels;

    MusicImpl()
        : kind(MK_None), looping(false), paused(false), ended(false),
          synth(nullptr), events_head(nullptr), cursor(nullptr),
          cur_ms(0.0), total_ms(0),
          ogg(nullptr), ogg_data(nullptr), ogg_channels(0) {}
};

// --- Global SoundFont cache ---------------------------------------------
// Loaded lazily on first MIDI open. The master tsf is never used to render
// directly — we tsf_copy() it per stream so channel state is isolated.
static tsf*  g_sf_master = nullptr;
static bool  g_sf_tried  = false;

static void try_load_soundfont() {
    if (g_sf_tried) return;
    g_sf_tried = true;

    // Probe paths the web shell populates. /soundfonts/uzdoom.sf2 is the
    // server-side-hosted default; /soundfont.sf2 is the user-upload path
    // (see uzdoom-loader.js::SoundFont picker).
    const char* paths[] = {
        "/soundfonts/uzdoom.sf2",
        "/soundfont.sf2",
        "soundfont.sf2",
    };
    for (const char* p : paths) {
        FILE* f = fopen(p, "rb");
        if (!f) continue;
        fseek(f, 0, SEEK_END);
        long n = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (n <= 0) { fclose(f); continue; }
        uint8_t* buf = (uint8_t*)std::malloc((size_t)n);
        if (!buf) { fclose(f); continue; }
        size_t r = fread(buf, 1, (size_t)n, f);
        fclose(f);
        if ((long)r != n) { std::free(buf); continue; }
        g_sf_master = tsf_load_memory(buf, (int)n);
        std::free(buf); // tsf copied what it needs
        if (g_sf_master) {
            tsf_set_output(g_sf_master, TSF_STEREO_INTERLEAVED, kSampleRate, kTsfGainDb);
#ifdef __EMSCRIPTEN__
            // Surface once so the user knows MIDI is live.
            static int announced = 0;
            if (!announced++) {
                fprintf(stderr, "[zmusic-stub] SoundFont loaded from %s (%ld bytes)\n", p, n);
            }
#endif
            return;
        }
    }
#ifdef __EMSCRIPTEN__
    fprintf(stderr, "[zmusic-stub] No /soundfont.sf2 — MIDI music will be silent.\n");
#endif
}

// --- MUS -> MIDI conversion ---------------------------------------------
// MUS (Doom's simplified MIDI) laid out as:
//   [0..3]   "MUS\x1A"
//   [4..5]   scoreLen  (uint16 LE)
//   [6..7]   scoreStart(uint16 LE)
//   [8..9]   primaryChannels
//   [10..11] secondaryChannels
//   [12..13] instrumentCount
//   [14..15] reserved
//   [16..]   instrument patches (uint16 * instrumentCount)
//   [scoreStart..scoreStart+scoreLen] events
//
// Event byte = (last << 7) | (type << 4) | channel.
// Inter-event delays use MIDI's variable-length encoding (7 bits per byte,
// high bit = continuation), so we can read and re-emit them byte-for-byte.

static void midi_push_varlen(uint8_t*& out, size_t& cap, size_t& pos, uint32_t v);
static bool ensure_cap(uint8_t*& out, size_t& cap, size_t need);

// MUS controller number -> MIDI controller number. Entry 0 is special
// (instrument change -> program change, handled separately).
static const uint8_t kMusCtrlToMidi[10] = {
    0  /* instrument change (special) */,
    0  /* bank select MSB */,
    1  /* modulation */,
    7  /* volume */,
    10 /* pan */,
    11 /* expression */,
    91 /* reverb depth */,
    93 /* chorus depth */,
    64 /* sustain pedal */,
    67 /* soft pedal */,
};

// MUS system-event number -> MIDI controller number.
static const uint8_t kMusSysToMidi[6] = {
    120 /* all sounds off */,
    121 /* reset all controllers */,  // MUS 11 really means "all notes off"
    126 /* mono on */,
    127 /* poly on */,
    123 /* all notes off */,
    0
};

// MUS channels use 15 for percussion; MIDI uses 9. Swap.
static inline uint8_t remap_channel(uint8_t c) {
    if (c == 15) return 9;
    if (c == 9)  return 15;
    return c;
}

static bool ensure_cap(uint8_t*& out, size_t& cap, size_t need) {
    if (need <= cap) return true;
    size_t nc = cap ? cap * 2 : 1024;
    while (nc < need) nc *= 2;
    uint8_t* p = (uint8_t*)std::realloc(out, nc);
    if (!p) return false;
    out = p;
    cap = nc;
    return true;
}

static inline bool write_u8(uint8_t*& out, size_t& cap, size_t& pos, uint8_t v) {
    if (!ensure_cap(out, cap, pos + 1)) return false;
    out[pos++] = v;
    return true;
}

static inline bool write_bytes(uint8_t*& out, size_t& cap, size_t& pos,
                               const uint8_t* src, size_t n) {
    if (!ensure_cap(out, cap, pos + n)) return false;
    memcpy(out + pos, src, n);
    pos += n;
    return true;
}

static void midi_push_varlen(uint8_t*& out, size_t& cap, size_t& pos, uint32_t v) {
    uint8_t b[5];
    int i = 0;
    b[i++] = (uint8_t)(v & 0x7F);
    v >>= 7;
    while (v) { b[i++] = (uint8_t)((v & 0x7F) | 0x80); v >>= 7; }
    while (i > 0) write_u8(out, cap, pos, b[--i]);
}

// Returns a malloc'd SMF buffer on success; caller frees. Writes size to
// *out_size. Returns nullptr on failure.
static uint8_t* mus2mid(const uint8_t* mus, size_t mus_len, size_t* out_size) {
    if (mus_len < 16) return nullptr;
    if (memcmp(mus, "MUS\x1A", 4) != 0) return nullptr;

    uint16_t score_len   = (uint16_t)mus[4] | ((uint16_t)mus[5] << 8);
    uint16_t score_start = (uint16_t)mus[6] | ((uint16_t)mus[7] << 8);

    if ((size_t)score_start + (size_t)score_len > mus_len) return nullptr;

    const uint8_t* ev     = mus + score_start;
    const uint8_t* ev_end = ev + score_len;

    uint8_t* out = nullptr;
    size_t   cap = 0;
    size_t   pos = 0;

    // MThd header. Division 89 ticks/quarter gives us clean MUS timing.
    static const uint8_t mthd[] = {
        'M','T','h','d', 0,0,0,6, 0,0, 0,1, 0,89
    };
    if (!write_bytes(out, cap, pos, mthd, sizeof(mthd))) return nullptr;

    // MTrk header with a placeholder 4-byte length we'll patch.
    size_t trk_len_off = pos + 4;
    static const uint8_t mtrk[] = {'M','T','r','k', 0,0,0,0};
    if (!write_bytes(out, cap, pos, mtrk, sizeof(mtrk))) { std::free(out); return nullptr; }
    size_t trk_data_start = pos;

    // Initial tempo meta event (set 635714 us/quarter so 89 tpq * x = 140
    // ticks/sec ≈ MUS native tick rate).
    // delta=0 ; FF 51 03 <3 bytes tempo>
    static const uint8_t tempo_meta[] = {
        0, 0xFF, 0x51, 0x03, 0x09, 0xB3, 0x42  // 0x09B342 = 635714
    };
    if (!write_bytes(out, cap, pos, tempo_meta, sizeof(tempo_meta))) {
        std::free(out); return nullptr;
    }

    // Per-channel last program number (for MUS "instrument change" ctrl,
    // which maps to MIDI program change — needs running channel tracking).
    // Already tracked implicitly via MUS; we just emit what we see.

    // Delta-time in MIDI ticks to emit before the next event. Starts at 0;
    // filled in by the delay that follows each non-"last" MUS event.
    uint32_t delta = 0;
    bool done = false;

    while (ev < ev_end && !done) {
        uint8_t desc = *ev++;
        uint8_t last = (desc >> 7) & 1;
        uint8_t type = (desc >> 4) & 7;
        uint8_t ch   = remap_channel(desc & 0x0F);

        switch (type) {
        case 0: { // release note
            if (ev >= ev_end) { done = true; break; }
            uint8_t note = *ev++ & 0x7F;
            midi_push_varlen(out, cap, pos, delta); delta = 0;
            write_u8(out, cap, pos, (uint8_t)(0x80 | ch));
            write_u8(out, cap, pos, note);
            write_u8(out, cap, pos, 0x40);            // release vel
            break;
        }
        case 1: { // play note
            if (ev >= ev_end) { done = true; break; }
            uint8_t nb = *ev++;
            uint8_t note = nb & 0x7F;
            uint8_t vel  = 0x7F;
            if (nb & 0x80) {
                if (ev >= ev_end) { done = true; break; }
                vel = *ev++ & 0x7F;
            }
            midi_push_varlen(out, cap, pos, delta); delta = 0;
            write_u8(out, cap, pos, (uint8_t)(0x90 | ch));
            write_u8(out, cap, pos, note);
            write_u8(out, cap, pos, vel);
            break;
        }
        case 2: { // pitch bend (1 byte, 0..255, 128 = center)
            if (ev >= ev_end) { done = true; break; }
            uint8_t b = *ev++;
            // Spread 0..255 across the full 14-bit MIDI pitch range.
            uint16_t bend = (uint16_t)b * 64; // 0..16320
            midi_push_varlen(out, cap, pos, delta); delta = 0;
            write_u8(out, cap, pos, (uint8_t)(0xE0 | ch));
            write_u8(out, cap, pos, (uint8_t)(bend & 0x7F));
            write_u8(out, cap, pos, (uint8_t)((bend >> 7) & 0x7F));
            break;
        }
        case 3: { // system event
            if (ev >= ev_end) { done = true; break; }
            uint8_t s = *ev++;
            // MUS 10..14 → MIDI controllers 120..123, 126, 127
            if (s >= 10 && s <= 14) {
                uint8_t midi_ctrl;
                switch (s) {
                    case 10: midi_ctrl = 120; break; // all sounds off
                    case 11: midi_ctrl = 123; break; // all notes off
                    case 12: midi_ctrl = 126; break; // mono
                    case 13: midi_ctrl = 127; break; // poly
                    case 14: midi_ctrl = 121; break; // reset all controllers
                    default: midi_ctrl = 120; break;
                }
                midi_push_varlen(out, cap, pos, delta); delta = 0;
                write_u8(out, cap, pos, (uint8_t)(0xB0 | ch));
                write_u8(out, cap, pos, midi_ctrl);
                write_u8(out, cap, pos, 0);
            }
            break;
        }
        case 4: { // controller
            if (ev + 1 >= ev_end) { done = true; break; }
            uint8_t cnum = *ev++;
            uint8_t cval = *ev++ & 0x7F;
            midi_push_varlen(out, cap, pos, delta); delta = 0;
            if (cnum == 0) {
                // Program change. MUS uses full 8 bits; MIDI program = 0..127.
                write_u8(out, cap, pos, (uint8_t)(0xC0 | ch));
                write_u8(out, cap, pos, cval);
            } else if (cnum < 10) {
                write_u8(out, cap, pos, (uint8_t)(0xB0 | ch));
                write_u8(out, cap, pos, kMusCtrlToMidi[cnum]);
                write_u8(out, cap, pos, cval);
            }
            break;
        }
        case 5: // end of measure — purely informational in MUS
            break;
        case 6: // score end
            done = true;
            break;
        default:
            // type 7 is reserved/unused; ignore
            break;
        }

        // In MUS format, bit 7 of the event descriptor (`last` here) SET
        // means a varlen delay (in ticks) follows this event. If the bit
        // is cleared, the next event follows immediately (delta unchanged).
        // Earlier revs of this code had the sense inverted — the resulting
        // SMF had nonsense timing (billions of ms "total length") and notes
        // would dispatch but never advance.
        if (last && !done) {
            uint32_t d = 0;
            while (ev < ev_end) {
                uint8_t b = *ev++;
                d = (d << 7) | (b & 0x7F);
                if (!(b & 0x80)) break;
            }
            delta += d;
        }
    }

    // End-of-track meta event.
    static const uint8_t eot[] = { 0, 0xFF, 0x2F, 0x00 };
    write_bytes(out, cap, pos, eot, sizeof(eot));

    // Patch MTrk length (big-endian, 4 bytes at trk_len_off).
    uint32_t trk_len = (uint32_t)(pos - trk_data_start);
    out[trk_len_off + 0] = (uint8_t)((trk_len >> 24) & 0xFF);
    out[trk_len_off + 1] = (uint8_t)((trk_len >> 16) & 0xFF);
    out[trk_len_off + 2] = (uint8_t)((trk_len >>  8) & 0xFF);
    out[trk_len_off + 3] = (uint8_t)((trk_len >>  0) & 0xFF);

    *out_size = pos;
    return out;
}

// --- MIDI stream internal helpers ---------------------------------------
static bool open_midi_from_memory(MusicImpl* m, const uint8_t* data, size_t len) {
    try_load_soundfont();
    if (!g_sf_master) { g_last_error = "no SoundFont loaded"; return false; }

    // If it's MUS, convert to SMF first; if it's already MIDI, feed directly.
    uint8_t* smf_owned = nullptr;
    const uint8_t* smf_ptr;
    size_t smf_len;

    if (len >= 4 && memcmp(data, "MUS\x1A", 4) == 0) {
        size_t sz = 0;
        smf_owned = mus2mid(data, len, &sz);
        if (!smf_owned) { g_last_error = "mus2mid failed"; return false; }
        smf_ptr = smf_owned;
        smf_len = sz;
    } else if (len >= 4 && memcmp(data, "MThd", 4) == 0) {
        smf_ptr = data;
        smf_len = len;
    } else {
        return false;
    }

    tml_message* evs = tml_load_memory(smf_ptr, (int)smf_len);
    if (smf_owned) std::free(smf_owned);
    if (!evs) { g_last_error = "tml_load_memory failed"; return false; }

    // Duplicate the master SF so this stream has isolated channel state.
    tsf* synth = tsf_copy(g_sf_master);
    if (!synth) { tml_free(evs); g_last_error = "tsf_copy failed"; return false; }
    tsf_set_output(synth, TSF_STEREO_INTERLEAVED, kSampleRate, kTsfGainDb);
    // Make channel 9 use the drum bank (General MIDI convention).
    tsf_channel_set_bank_preset(synth, 9, 128, 0);

    unsigned int total_ms = 0;
    tml_get_info(evs, nullptr, nullptr, nullptr, nullptr, &total_ms);

    m->kind        = MK_Midi;
    m->synth       = synth;
    m->events_head = evs;
    m->cursor      = evs;
    m->cur_ms      = 0.0;
    m->total_ms    = total_ms;
    return true;
}

static bool open_ogg_from_memory(MusicImpl* m, const uint8_t* data, size_t len) {
    // stb_vorbis aliases its input, so we must own the buffer for the stream
    // lifetime.
    uint8_t* buf = (uint8_t*)std::malloc(len);
    if (!buf) return false;
    memcpy(buf, data, len);

    int err = 0;
    stb_vorbis* v = stb_vorbis_open_memory(buf, (int)len, &err, nullptr);
    if (!v) { std::free(buf); g_last_error = "stb_vorbis_open_memory failed"; return false; }

    stb_vorbis_info info = stb_vorbis_get_info(v);
    if (info.channels < 1 || info.channels > 2) {
        stb_vorbis_close(v); std::free(buf);
        g_last_error = "unsupported OGG channel count";
        return false;
    }

    m->kind         = MK_Ogg;
    m->ogg          = v;
    m->ogg_data     = buf;
    m->ogg_channels = info.channels;
    return true;
}

// --- Render helpers for FillStream -------------------------------------
// Advance TSF by `frames` stereo float frames into out[], dispatching MIDI
// events at sample-accurate offsets within the buffer.
//
// The earlier "dispatch everything in [cur_ms, cur_ms+win_ms) then render
// the whole window" approach produced an audible click every ~93 ms: every
// note that should have fired anywhere inside the buffer actually fired at
// sample 0, piling up fast-attack envelopes into a transient at the buffer
// boundary. At typical MIDI note spacings (~200 ms) that reads as
// "click every other note." Symptom reported by the user, reproduced on
// D_E1M1, gone once we interleave.
//
// The correct pattern: walk the event list, render up to the *next* event's
// timestamp, dispatch it, repeat. The rendered buffer ends up sample-
// accurate w.r.t. MIDI timing, and transients are spread out like the music
// says they should be.
static void render_midi(MusicImpl* m, float* out, int frames) {
    const double ms_per_frame = 1000.0 / (double)kSampleRate;
    int rendered = 0;

    while (rendered < frames) {
        int chunk;
        if (m->cursor) {
            const double event_ms = (double)m->cursor->time;
            if (event_ms <= m->cur_ms) {
                // Event is due (or overdue) — dispatch without advancing.
                chunk = 0;
            } else {
                const double delta_ms = event_ms - m->cur_ms;
                // Round down: we'd rather fire the event a fraction of a
                // sample early than late (tsf voice envelopes absorb the
                // fraction, and firing late would let the next loop's
                // chunk=0 dispatch handle it anyway).
                chunk = (int)(delta_ms / ms_per_frame);
                if (chunk < 1) chunk = 1; // guarantee forward progress
                const int remaining = frames - rendered;
                if (chunk > remaining) chunk = remaining;
            }
        } else {
            // No more events — render the rest of the buffer in one shot.
            chunk = frames - rendered;
        }

        if (chunk > 0) {
            tsf_render_float(m->synth, out + rendered * kChannels, chunk, 0);
            rendered += chunk;
            m->cur_ms += (double)chunk * ms_per_frame;
        }

        // Dispatch all events now at or before cur_ms. Multiple events can
        // share a timestamp (chords, simultaneous CC changes) — drain them
        // before rendering the next chunk.
        while (m->cursor && (double)m->cursor->time <= m->cur_ms) {
            tml_message* e = m->cursor;
            switch (e->type) {
                case TML_PROGRAM_CHANGE:
                    tsf_channel_set_presetnumber(m->synth, e->channel,
                                                 (unsigned char)e->program,
                                                 (e->channel == 9) ? 1 : 0);
                    break;
                case TML_NOTE_ON:
                    if ((unsigned char)e->velocity == 0)
                        tsf_channel_note_off(m->synth, e->channel, (unsigned char)e->key);
                    else
                        tsf_channel_note_on(m->synth, e->channel,
                                            (unsigned char)e->key,
                                            (unsigned char)e->velocity / 127.0f);
                    break;
                case TML_NOTE_OFF:
                    tsf_channel_note_off(m->synth, e->channel, (unsigned char)e->key);
                    break;
                case TML_PITCH_BEND:
                    tsf_channel_set_pitchwheel(m->synth, e->channel, e->pitch_bend);
                    break;
                case TML_CONTROL_CHANGE:
                    tsf_channel_midi_control(m->synth, e->channel,
                                             (unsigned char)e->control,
                                             (unsigned char)e->control_value);
                    break;
                default:
                    break; // SET_TEMPO, SYSEX, etc. — TSF doesn't need us to act
            }
            m->cursor = e->next;
        }
    }

    // End-of-track handling. tml_get_info gives us total duration; once
    // we're past it with no cursor remaining, we've finished.
    if (!m->cursor && m->cur_ms >= (double)m->total_ms) {
        if (m->looping) {
            m->cursor = m->events_head;
            m->cur_ms = 0.0;
            tsf_reset(m->synth);
        } else {
            m->ended = true;
        }
    }
}

static int render_ogg(MusicImpl* m, float* out, int frames) {
    // stb_vorbis_get_samples_float_interleaved returns frames decoded.
    int got = stb_vorbis_get_samples_float_interleaved(
        m->ogg, 2, out, frames * 2);

    // Mono expansion: stb upmixes automatically when channels=1 vs. 2 via
    // the `channels` argument; if source is mono it duplicates to both.
    // Actually check: passing channels=2 for a mono OGG … let's be safe:
    if (m->ogg_channels == 1 && got > 0) {
        // stb_vorbis_get_samples_float_interleaved is documented to
        // up/down-mix to `channels`; nothing more to do.
    }

    if (got <= 0) {
        if (m->looping) {
            stb_vorbis_seek_start(m->ogg);
            got = stb_vorbis_get_samples_float_interleaved(
                m->ogg, 2, out, frames * 2);
            if (got <= 0) { m->ended = true; return 0; }
        } else {
            m->ended = true;
            return 0;
        }
    }
    return got;
}

} // namespace

// --- ZMusic_OpenSong* family --------------------------------------------
// The real engine path is ZMusic_OpenSong(reader, ...). We slurp the reader
// into memory, close it, then dispatch by magic bytes.

static uint8_t* slurp_reader(ZMusicCustomReader* r, size_t* out_len) {
    if (!r) return nullptr;

    // Probe size via seek; fall back to incremental read if seek fails.
    long cur = r->tell ? r->tell(r) : 0;
    long end = -1;
    if (r->seek && r->tell) {
        if (r->seek(r, 0, 2 /* SEEK_END */) == 0) {
            end = r->tell(r);
            r->seek(r, cur, 0 /* SEEK_SET */);
        }
    }

    uint8_t* buf = nullptr;
    size_t   len = 0;

    if (end > cur) {
        long remaining = end - cur;
        buf = (uint8_t*)std::malloc((size_t)remaining);
        if (!buf) return nullptr;
        long got = r->read ? r->read(r, buf, (int32_t)remaining) : 0;
        if (got <= 0) { std::free(buf); return nullptr; }
        len = (size_t)got;
    } else {
        // Unknown size: read in chunks until EOF.
        size_t cap = 0;
        while (true) {
            if (len + 4096 > cap) {
                size_t nc = cap ? cap * 2 : 8192;
                while (nc < len + 4096) nc *= 2;
                uint8_t* p = (uint8_t*)std::realloc(buf, nc);
                if (!p) { std::free(buf); return nullptr; }
                buf = p; cap = nc;
            }
            long got = r->read ? r->read(r, buf + len, 4096) : 0;
            if (got <= 0) break;
            len += (size_t)got;
        }
        if (len == 0) { std::free(buf); return nullptr; }
    }

    *out_len = len;
    return buf;
}

static ZMusic_MusicStream open_from_buffer(const uint8_t* data, size_t len) {
    if (!data || len < 4) return nullptr;
    MusicImpl* m = new (std::nothrow) MusicImpl();
    if (!m) return nullptr;

    bool ok = false;
    if (memcmp(data, "MUS\x1A", 4) == 0 || memcmp(data, "MThd", 4) == 0) {
        ok = open_midi_from_memory(m, data, len);
    } else if (memcmp(data, "OggS", 4) == 0) {
        ok = open_ogg_from_memory(m, data, len);
    } else {
        g_last_error = "unrecognized music format";
    }
    if (!ok) { delete m; return nullptr; }
    return (ZMusic_MusicStream)m;
}

extern "C" ZMusic_MusicStream ZMusic_OpenSong(ZMusicCustomReader* reader, EMidiDevice, const char*) {
    if (!reader) return nullptr;
    size_t len = 0;
    uint8_t* data = slurp_reader(reader, &len);
    if (reader->close) reader->close(reader);
    if (!data) return nullptr;
    ZMusic_MusicStream h = open_from_buffer(data, len);
    std::free(data);
    return h;
}

extern "C" ZMusic_MusicStream ZMusic_OpenSongFile(const char* filename, EMidiDevice, const char*) {
    if (!filename) return nullptr;
    FILE* f = fopen(filename, "rb");
    if (!f) return nullptr;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n <= 0) { fclose(f); return nullptr; }
    uint8_t* buf = (uint8_t*)std::malloc((size_t)n);
    if (!buf) { fclose(f); return nullptr; }
    size_t r = fread(buf, 1, (size_t)n, f);
    fclose(f);
    if ((long)r != n) { std::free(buf); return nullptr; }
    ZMusic_MusicStream h = open_from_buffer(buf, (size_t)n);
    std::free(buf);
    return h;
}

extern "C" ZMusic_MusicStream ZMusic_OpenSongMem(const void* data, size_t size, EMidiDevice, const char*) {
    return open_from_buffer((const uint8_t*)data, size);
}

extern "C" ZMusic_MusicStream ZMusic_OpenCDSong(int, int) { return nullptr; }

// --- ZMusic_FillStream ---------------------------------------------------
// Diagnostic note: an earlier version of this function had per-buffer
// fprintf(stderr, ...) trace lines under __EMSCRIPTEN__ to verify the
// wall-clock / audio-rate ratio and render peak. They are GONE now — each
// stderr write on a pthread proxies synchronously back to the main thread
// (printErr -> doWritev -> _fd_write -> __emscripten_receive_on_main_thread_js),
// and with FillStream firing every ~93 ms that proxy hop serialized with
// rAF and blew the frame budget just often enough to be audible as a
// periodic stutter. If diagnostics are ever needed again, accumulate into
// a ring buffer and drain on a timer from the main thread — do NOT log
// inline from this hot path.
extern "C" zmusic_bool ZMusic_FillStream(ZMusic_MusicStream h, void* buff, int len) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    if (!m || !buff || len <= 0) return 0;
    if (m->paused || m->ended) {
        memset(buff, 0, (size_t)len);
        return 0;
    }

    // We emit stereo float32. Frame count = bytes / 8.
    const int frames = len / (int)(sizeof(float) * kChannels);
    float* out = (float*)buff;

    if (m->kind == MK_Midi && m->synth) {
        render_midi(m, out, frames);
        return m->ended ? 0 : 1;
    }
    if (m->kind == MK_Ogg && m->ogg) {
        int got = render_ogg(m, out, frames);
        if (got < frames) {
            // Zero the tail so we don't emit junk on stream end.
            float* tail = out + got * kChannels;
            memset(tail, 0, (size_t)(frames - got) * sizeof(float) * kChannels);
        }
        return m->ended ? 0 : 1;
    }

    memset(buff, 0, (size_t)len);
    return 0;
}

// --- stream lifecycle knobs ---------------------------------------------
extern "C" zmusic_bool ZMusic_Start(ZMusic_MusicStream h, int /*subsong*/, zmusic_bool loop) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    if (!m) return 0;
    m->looping = (loop != 0);
    m->paused  = false;
    m->ended   = false;
    if (m->kind == MK_Midi) {
        m->cursor = m->events_head;
        m->cur_ms = 0.0;
        if (m->synth) tsf_reset(m->synth);
    } else if (m->kind == MK_Ogg) {
        stb_vorbis_seek_start(m->ogg);
    }
    return 1;
}
extern "C" void ZMusic_Pause(ZMusic_MusicStream h) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    if (m) m->paused = true;
}
extern "C" void ZMusic_Resume(ZMusic_MusicStream h) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    if (m) m->paused = false;
}
extern "C" void ZMusic_Update(ZMusic_MusicStream) {}
extern "C" zmusic_bool ZMusic_IsPlaying(ZMusic_MusicStream h) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    return (m && !m->ended) ? 1 : 0;
}
extern "C" void ZMusic_Stop(ZMusic_MusicStream h) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    if (m) {
        m->ended = true;
        if (m->synth) tsf_note_off_all(m->synth);
    }
}
extern "C" void ZMusic_Close(ZMusic_MusicStream h) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    if (!m) return;
    if (m->synth)       tsf_close(m->synth);
    if (m->events_head) tml_free(m->events_head);
    if (m->ogg)         stb_vorbis_close(m->ogg);
    if (m->ogg_data)    std::free(m->ogg_data);
    delete m;
}
extern "C" zmusic_bool ZMusic_SetSubsong(ZMusic_MusicStream, int) { return 0; }
extern "C" zmusic_bool ZMusic_IsLooping(ZMusic_MusicStream h) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    return (m && m->looping) ? 1 : 0;
}
extern "C" int ZMusic_GetDeviceType(ZMusic_MusicStream h) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    if (!m) return 0;
    return (m->kind == MK_Midi) ? MDEV_SNDSYS : MDEV_STANDARD;
}
extern "C" zmusic_bool ZMusic_IsMIDI(ZMusic_MusicStream h) {
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    return (m && m->kind == MK_Midi) ? 1 : 0;
}
extern "C" void ZMusic_VolumeChanged(ZMusic_MusicStream) {}
extern "C" void ZMusic_GetStreamInfo(ZMusic_MusicStream h, SoundStreamInfo* info) {
    if (!info) return;
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    if (!m || m->kind == MK_None) {
        memset(info, 0, sizeof(*info));
        return;
    }
    // Positive mNumChannels = 32-bit float output (what music.cpp prefers).
    info->mBufferSize  = kBufBytes;
    info->mSampleRate  = kSampleRate;
    info->mNumChannels = kChannels;
}
extern "C" void ZMusic_GetStreamInfoEx(ZMusic_MusicStream h, SoundStreamInfoEx* info) {
    if (!info) return;
    MusicImpl* m = reinterpret_cast<MusicImpl*>(h);
    if (!m || m->kind == MK_None) {
        memset(info, 0, sizeof(*info));
        return;
    }
    info->mBufferSize    = kBufBytes;
    info->mSampleRate    = kSampleRate;
    info->mSampleType    = SampleType_Float32;
    info->mChannelConfig = ChannelConfig_Stereo;
}
extern "C" zmusic_bool ChangeMusicSettingInt(EIntConfigKey, ZMusic_MusicStream, int value, int* pRealValue) {
    if (pRealValue) *pRealValue = value;
    return 0;
}
extern "C" zmusic_bool ChangeMusicSettingFloat(EFloatConfigKey, ZMusic_MusicStream, float value, float* pRealValue) {
    if (pRealValue) *pRealValue = value;
    return 0;
}
extern "C" zmusic_bool ChangeMusicSettingString(EStringConfigKey, ZMusic_MusicStream, const char*) { return 0; }
extern "C" const char* ZMusic_GetStats(ZMusic_MusicStream) { return "ZMusic stub (TSF + stb_vorbis)"; }

// ==========================================================================
// Sound-effect decoder: real WAV + OGG implementations
// ==========================================================================
//
// The engine's SFX path (src/common/audio/sound/oalsound.cpp → LoadSound)
// calls:
//   CreateDecoder(data, len, true)           — opaque handle we own
//   SoundDecoder_GetInfo(h, &srate, &cc, &st) — report stream format
//   SoundDecoder_Read(h, buf, nbytes) loop   — decode into AL upload buffer
//   SoundDecoder_Close(h)                    — release
//
// DMX / PC-speaker lumps never hit this path — they go through LoadSoundRaw.
// What DOES hit us is everything BD ships in its PK3: OGG and WAV.
//
// We always report 16-bit PCM to the engine, because:
//   • OGG decoding via stb_vorbis naturally yields int16.
//   • WAV 8-bit gets upconverted (trivial: (sample-128)<<8).
//   • WAV 24/32-bit float/int gets downconverted.
// This keeps the engine-facing SampleType stable.

namespace {

enum DecoderKind : uint8_t { DK_None = 0, DK_Wav = 1, DK_Ogg = 2 };

struct WavState {
    // Points into the caller's buffer (oalsound.cpp passes isstatic=true,
    // so the engine keeps the data alive for the duration of LoadSound).
    const uint8_t* pcm;     // start of PCM bytes inside the WAV
    size_t         pcm_len; // byte count of PCM data (post-format conversion)
    size_t         pcm_pos; // read cursor within pcm_len
    // If we needed to upconvert 8-bit or downconvert float/24-bit we own
    // a converted buffer here; otherwise this is null and `pcm` aliases
    // the original mmap'd lump.
    uint8_t*       owned;
};

struct OggState {
    stb_vorbis* vorbis;
    // short-term scratch for the leftover-sample splice between Reads.
    // stb_vorbis yields whole frames; we buffer any sample overhang.
    int16_t  overflow[4096];
    int      overflow_samples;   // number of int16 samples held (NOT bytes)
    int      overflow_read;      // samples already consumed
};

struct SoundDecoderImpl {
    DecoderKind kind;
    int         samplerate;
    int         channels;   // 1 or 2
    SampleType  sampletype; // we always emit Int16
    union {
        WavState wav;
        OggState ogg;
    };

    SoundDecoderImpl() : kind(DK_None), samplerate(0), channels(0),
                         sampletype(SampleType_Int16) {}
};

// --- little-endian readers (WAV is always little-endian) -----------------
static inline uint16_t rd16le(const uint8_t* p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}
static inline uint32_t rd32le(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// --- WAV parser ----------------------------------------------------------
// Accepts PCM (fmt tag 1) and IEEE float (fmt tag 3). Converts 8-bit / float
// to int16. Mono/stereo only. Extensible fmt chunks (WAVE_FORMAT_EXTENSIBLE)
// are handled for the common PCM sub-format.
static bool parse_wav(SoundDecoderImpl* d, const uint8_t* data, size_t len) {
    if (len < 44) return false;
    if (memcmp(data, "RIFF", 4) != 0 || memcmp(data + 8, "WAVE", 4) != 0)
        return false;

    size_t pos = 12;
    uint16_t fmt_tag = 0;
    uint16_t channels = 0;
    uint32_t sample_rate = 0;
    uint16_t bits = 0;
    const uint8_t* data_ptr = nullptr;
    uint32_t data_len = 0;

    while (pos + 8 <= len) {
        const uint8_t* cid = data + pos;
        uint32_t csz = rd32le(data + pos + 4);
        pos += 8;
        if (pos + csz > len) break;

        if (memcmp(cid, "fmt ", 4) == 0 && csz >= 16) {
            fmt_tag     = rd16le(data + pos + 0);
            channels    = rd16le(data + pos + 2);
            sample_rate = rd32le(data + pos + 4);
            bits        = rd16le(data + pos + 14);
            // WAVE_FORMAT_EXTENSIBLE: subformat GUID tells the real tag.
            // The GUID is at pos+24 (8 bytes in), first 2 bytes = format tag.
            if (fmt_tag == 0xFFFE && csz >= 40) {
                fmt_tag = rd16le(data + pos + 24);
            }
        } else if (memcmp(cid, "data", 4) == 0) {
            data_ptr = data + pos;
            data_len = csz;
            // We don't break — some writers stash cue/list after data, but
            // for our purposes we already have what we need.
            break;
        }
        // chunks are word-aligned
        pos += csz + (csz & 1);
    }

    if (!data_ptr || data_len == 0 || channels == 0 || channels > 2 ||
        sample_rate == 0 || bits == 0) {
        return false;
    }

    d->channels   = channels;
    d->samplerate = (int)sample_rate;
    d->sampletype = SampleType_Int16;
    d->kind       = DK_Wav;

    // --- format → int16 conversion ---------------------------------------
    // Fast path: already int16 PCM. No allocation, alias the lump.
    if (fmt_tag == 1 /* PCM */ && bits == 16) {
        d->wav.pcm     = data_ptr;
        d->wav.pcm_len = data_len;
        d->wav.pcm_pos = 0;
        d->wav.owned   = nullptr;
        return true;
    }

    // Conversion paths: allocate and convert up-front. Doom SFX are short;
    // even a 10-second 44.1k stereo is ~1.7 MB.
    size_t out_samples;
    uint8_t* out = nullptr;

    if (fmt_tag == 1 && bits == 8) {
        // 8-bit unsigned PCM → signed 16-bit
        out_samples = data_len; // 1 byte per sample in, 2 out
        out = (uint8_t*)std::malloc(out_samples * 2);
        if (!out) return false;
        int16_t* dst = (int16_t*)out;
        for (size_t i = 0; i < out_samples; ++i) {
            dst[i] = (int16_t)((int)data_ptr[i] - 128) << 8;
        }
        d->wav.pcm     = out;
        d->wav.pcm_len = out_samples * 2;
    } else if (fmt_tag == 1 && bits == 24) {
        // 24-bit signed LE PCM → 16-bit
        if ((data_len % 3) != 0) return false;
        out_samples = data_len / 3;
        out = (uint8_t*)std::malloc(out_samples * 2);
        if (!out) return false;
        int16_t* dst = (int16_t*)out;
        for (size_t i = 0; i < out_samples; ++i) {
            int32_t s = (int32_t)data_ptr[i * 3] |
                        ((int32_t)data_ptr[i * 3 + 1] << 8) |
                        ((int32_t)((int8_t)data_ptr[i * 3 + 2]) << 16);
            dst[i] = (int16_t)(s >> 8);
        }
        d->wav.pcm     = out;
        d->wav.pcm_len = out_samples * 2;
    } else if (fmt_tag == 1 && bits == 32) {
        // 32-bit signed LE PCM → 16-bit (truncate high bits)
        if ((data_len & 3) != 0) return false;
        out_samples = data_len / 4;
        out = (uint8_t*)std::malloc(out_samples * 2);
        if (!out) return false;
        int16_t* dst = (int16_t*)out;
        for (size_t i = 0; i < out_samples; ++i) {
            int32_t s = (int32_t)rd32le(data_ptr + i * 4);
            dst[i] = (int16_t)(s >> 16);
        }
        d->wav.pcm     = out;
        d->wav.pcm_len = out_samples * 2;
    } else if (fmt_tag == 3 && bits == 32) {
        // IEEE float32 → 16-bit
        if ((data_len & 3) != 0) return false;
        out_samples = data_len / 4;
        out = (uint8_t*)std::malloc(out_samples * 2);
        if (!out) return false;
        int16_t* dst = (int16_t*)out;
        for (size_t i = 0; i < out_samples; ++i) {
            float f;
            uint32_t bits_u = rd32le(data_ptr + i * 4);
            memcpy(&f, &bits_u, 4);
            if (f >  1.0f) f =  1.0f;
            if (f < -1.0f) f = -1.0f;
            dst[i] = (int16_t)(f * 32767.0f);
        }
        d->wav.pcm     = out;
        d->wav.pcm_len = out_samples * 2;
    } else {
        return false;
    }

    d->wav.pcm_pos = 0;
    d->wav.owned   = out;
    return true;
}

// --- OGG setup -----------------------------------------------------------
static bool parse_ogg(SoundDecoderImpl* d, const uint8_t* data, size_t len) {
    int err = 0;
    stb_vorbis* v = stb_vorbis_open_memory(data, (int)len, &err, nullptr);
    if (!v) return false;

    stb_vorbis_info info = stb_vorbis_get_info(v);
    if (info.channels < 1 || info.channels > 2 || info.sample_rate == 0) {
        stb_vorbis_close(v);
        return false;
    }

    d->kind                  = DK_Ogg;
    d->channels              = info.channels;
    d->samplerate            = (int)info.sample_rate;
    d->sampletype            = SampleType_Int16;
    d->ogg.vorbis            = v;
    d->ogg.overflow_samples  = 0;
    d->ogg.overflow_read     = 0;
    return true;
}

} // namespace

// --- public C API --------------------------------------------------------
extern "C" struct SoundDecoder* CreateDecoder(const uint8_t* data, size_t size, zmusic_bool /*isstatic*/) {
    if (!data || size < 12) return nullptr;

    SoundDecoderImpl* d = new (std::nothrow) SoundDecoderImpl();
    if (!d) return nullptr;

    // Magic-byte sniff
    if (memcmp(data, "RIFF", 4) == 0 && size >= 12 && memcmp(data + 8, "WAVE", 4) == 0) {
        if (parse_wav(d, data, size)) return (SoundDecoder*)d;
    } else if (memcmp(data, "OggS", 4) == 0) {
        if (parse_ogg(d, data, size)) return (SoundDecoder*)d;
    }

    delete d;
    return nullptr;
}

extern "C" void SoundDecoder_GetInfo(struct SoundDecoder* h, int* samplerate, ChannelConfig* chans, SampleType* type) {
    SoundDecoderImpl* d = reinterpret_cast<SoundDecoderImpl*>(h);
    if (!d) {
        if (samplerate) *samplerate = 0;
        if (chans)      *chans = ChannelConfig_Mono;
        if (type)       *type = SampleType_UInt8;
        return;
    }
    if (samplerate) *samplerate = d->samplerate;
    if (chans)      *chans = (d->channels == 2) ? ChannelConfig_Stereo : ChannelConfig_Mono;
    if (type)       *type = d->sampletype;
}

extern "C" size_t SoundDecoder_Read(struct SoundDecoder* h, void* buf, size_t nbytes) {
    SoundDecoderImpl* d = reinterpret_cast<SoundDecoderImpl*>(h);
    if (!d || !buf || nbytes == 0) return 0;

    if (d->kind == DK_Wav) {
        size_t remaining = d->wav.pcm_len - d->wav.pcm_pos;
        size_t to_copy = (nbytes < remaining) ? nbytes : remaining;
        if (to_copy > 0) {
            memcpy(buf, d->wav.pcm + d->wav.pcm_pos, to_copy);
            d->wav.pcm_pos += to_copy;
        }
        return to_copy;
    }

    if (d->kind == DK_Ogg) {
        int16_t* out = (int16_t*)buf;
        size_t shorts_wanted = nbytes / 2;
        size_t shorts_written = 0;

        // First drain any leftover from a previous Read.
        if (d->ogg.overflow_samples > d->ogg.overflow_read) {
            int available = d->ogg.overflow_samples - d->ogg.overflow_read;
            int take = (int)shorts_wanted < available ? (int)shorts_wanted : available;
            memcpy(out, d->ogg.overflow + d->ogg.overflow_read, take * sizeof(int16_t));
            d->ogg.overflow_read += take;
            shorts_written += take;
            out += take;
        }

        // Then decode fresh frames until the caller's buffer fills or the
        // stream ends. stb_vorbis returns *frames* (samples-per-channel);
        // we convert to int16 count and handle per-frame channel layout.
        while (shorts_written < shorts_wanted) {
            // Decode directly into the caller's buffer when possible; this
            // avoids any mem copy for the hot path.
            size_t shorts_left = shorts_wanted - shorts_written;
            int frames = stb_vorbis_get_samples_short_interleaved(
                d->ogg.vorbis, d->channels, out, (int)shorts_left);
            if (frames <= 0) break; // end of stream
            int produced = frames * d->channels;
            shorts_written += produced;
            out            += produced;
        }

        return shorts_written * sizeof(int16_t);
    }

    return 0;
}

extern "C" void SoundDecoder_Close(struct SoundDecoder* h) {
    SoundDecoderImpl* d = reinterpret_cast<SoundDecoderImpl*>(h);
    if (!d) return;
    if (d->kind == DK_Wav) {
        if (d->wav.owned) std::free(d->wav.owned);
    } else if (d->kind == DK_Ogg) {
        if (d->ogg.vorbis) stb_vorbis_close(d->ogg.vorbis);
    }
    delete d;
}

// Loop-point tags are only used by the engine if the decoder reports them
// as "authoritative"; the fallback path uses SNDINFO $limit/$mustpreload
// style directives instead. Returning zeros is safe for SFX.
extern "C" void FindLoopTags(const uint8_t*, size_t, uint32_t* start, zmusic_bool* startass, uint32_t* end, zmusic_bool* endass) {
    if (start)    *start = 0;
    if (startass) *startass = 0;
    if (end)      *end = 0;
    if (endass)   *endass = 0;
}

// --- misc ---------------------------------------------------------------
extern "C" const ZMusicMidiOutDevice* ZMusic_GetMidiDevices(int* pAmount) {
    if (pAmount) *pAmount = 0;
    return nullptr;
}
extern "C" int ZMusic_GetADLBanks(const char* const**) { return 0; }

// --- CD audio (no CD in a browser) ---------------------------------------
extern "C" void CD_Stop() {}
extern "C" void CD_Pause() {}
extern "C" zmusic_bool CD_Resume() { return 0; }
extern "C" void CD_Eject() {}
extern "C" zmusic_bool CD_UnEject() { return 0; }
extern "C" void CD_Close() {}
extern "C" zmusic_bool CD_Enable(const char*) { return 0; }
