// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <obs.h>
#include <atomic>

// Encodes into a counting sink only: no files, sockets, or retained frames.
// Some hardware encoders expose their SPS only after producing a first packet.
inline std::atomic<unsigned> localProbePackets{0};
inline void registerEncoderProbe()
{
    obs_output_info info{};
    info.id = "strife_encoder_probe";
    info.flags = OBS_OUTPUT_VIDEO | OBS_OUTPUT_ENCODED;
    info.get_name = [](void *) { return "Local encoder probe"; };
    info.create = [](obs_data_t *, obs_output_t *output) -> void * { return output; };
    info.destroy = [](void *) {};
    info.start = [](void *data) {
        auto *output = static_cast<obs_output_t *>(data);
        return obs_output_initialize_encoders(output, 0) && obs_output_begin_data_capture(output, 0);
    };
    info.stop = [](void *data, uint64_t) { obs_output_end_data_capture(static_cast<obs_output_t *>(data)); };
    info.encoded_packet = [](void *, encoder_packet *packet) { if (packet && packet->size) localProbePackets++; };
    info.encoded_video_codecs = "h264";
    obs_register_output(&info);
}
