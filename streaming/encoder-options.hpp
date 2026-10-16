// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <obs.h>
#include <obs-avc.h>
#include <util/bmem.h>
#include <string>
#include <vector>
#include <chrono>
#include <thread>
#include "encoder-probe.hpp"

struct EncoderOption { std::string id, name; bool available; };
inline obs_data_t *encoderSettings(const std::string &id, int bitrate)
{
    auto *settings = obs_encoder_defaults(id.c_str());
    if (!settings) settings = obs_data_create();
    obs_data_set_string(settings, "profile", "baseline");
    obs_data_set_string(settings, "rate_control", id == "obs_nvenc_h264_tex" ? "cbr" : "CBR");
    obs_data_set_int(settings, "bitrate", bitrate);
    obs_data_set_int(settings, "max_bitrate", bitrate);
    obs_data_set_int(settings, "keyint_sec", 2);
    obs_data_set_int(settings, "bf", 0);
    obs_data_set_int(settings, "bframes", 0);
    obs_data_set_bool(settings, "repeat_headers", true);
    if (id == "obs_x264") obs_data_set_string(settings, "preset", "veryfast");
    if (id == "obs_nvenc_h264_tex") {
        obs_data_set_string(settings, "preset", "p4");
        obs_data_set_string(settings, "multipass", "disabled");
        obs_data_set_string(settings, "tuning", "ll");
    }
    return settings;
}
inline bool initializeBaseline(obs_encoder_t *encoder)
{
    if (!encoder) return false;
    auto *probe = obs_output_create("strife_encoder_probe", "Local encoder validation", nullptr, nullptr);
    if (!probe) return false;
    obs_output_set_video_encoder(probe, encoder);
    localProbePackets = 0;
    bool valid = obs_output_start(probe);
    obs_video_info video{}; obs_get_video_info(&video);
    // Allow an encoder lookahead window at 15 fps as well as at 60 fps.
    const auto deadline = std::chrono::steady_clock::now() +
        std::chrono::milliseconds(2000 + 60000ULL * video.fps_den / std::max(1u, video.fps_num));
    while (valid && !localProbePackets && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    valid = valid && localProbePackets > 0;
    uint8_t *extra = nullptr, *header = nullptr; size_t length = 0;
    if (valid && obs_encoder_get_extra_data(encoder, &extra, &length)) {
        const auto size = obs_parse_avc_header(&header, extra, length);
        if (size >= 4) blog(LOG_INFO, "Strife encoder SPS %s: %02x%02x%02x", obs_encoder_get_id(encoder), header[1], header[2], header[3]);
        valid = size >= 4 && header[0] == 1 && header[1] == 66 && header[3] <= 52;
        if (valid) {
            char profile[7];
            // Advertise the RFC 6184 Baseline constraint subset. Newer AMF
            // constraint flags remain in the actual SPS, not the SDP matcher.
            snprintf(profile, sizeof(profile), "%02x%02x%02x", header[1], header[2] & 0xf0, header[3]);
            auto *settings = obs_encoder_get_settings(encoder);
            obs_data_set_string(settings, "strife_profile_level_id", profile);
            obs_data_release(settings);
        }
        bfree(header);
    } else valid = false;
    obs_output_stop(probe);
    for (int i = 0; i < 100 && obs_output_active(probe); i++) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    obs_output_release(probe);
    return valid;
}
inline std::vector<EncoderOption> probeEncoders()
{
    std::vector<EncoderOption> choices = {
        {"obs_x264", "Software H.264 (x264)", false},
        {"obs_nvenc_h264_tex", "NVIDIA NVENC H.264", false},
        {"obs_qsv11_v2", "Intel Quick Sync H.264", false},
        {"h264_texture_amf", "AMD AMF H.264", false},
    };
    for (auto &choice : choices) {
        const char *codec = obs_get_encoder_codec(choice.id.c_str());
        if (!codec || std::string(codec) != "h264") continue;
        auto *settings = encoderSettings(choice.id, 8000);
        auto *encoder = obs_video_encoder_create(choice.id.c_str(), "Encoder availability check", settings, nullptr);
        obs_data_release(settings);
        if (encoder) {
            obs_encoder_set_video(encoder, obs_get_video());
            choice.available = initializeBaseline(encoder);
            obs_encoder_release(encoder);
        }
    }
    return choices;
}
