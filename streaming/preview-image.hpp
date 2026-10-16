// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <obs.h>
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

struct Dimensions { uint32_t width, height; };
inline Dimensions fitSource(uint32_t width, uint32_t height, uint32_t limitWidth, uint32_t limitHeight)
{
    if (width < 2 || height < 2) throw std::runtime_error("The source has no usable image.");
    const double scale = std::min({1.0, double(limitWidth) / width, double(limitHeight) / height});
    return {std::max(2u, static_cast<uint32_t>(std::floor(width * scale)) & ~1u),
        std::max(2u, static_cast<uint32_t>(std::floor(height * scale)) & ~1u)};
}
inline std::string base64(const std::vector<uint8_t> &bytes)
{
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    result.reserve((bytes.size() + 2) / 3 * 4);
    for (size_t i = 0; i < bytes.size(); i += 3) {
        uint32_t value = uint32_t(bytes[i]) << 16;
        if (i + 1 < bytes.size()) value |= uint32_t(bytes[i + 1]) << 8;
        if (i + 2 < bytes.size()) value |= bytes[i + 2];
        result += alphabet[(value >> 18) & 63]; result += alphabet[(value >> 12) & 63];
        result += i + 1 < bytes.size() ? alphabet[(value >> 6) & 63] : '=';
        result += i + 2 < bytes.size() ? alphabet[value & 63] : '=';
    }
    return result;
}
// Bounded, ephemeral local preview. BMP avoids adding an image codec dependency.
inline std::string previewImage(obs_source_t *source, bool thumbnail)
{
    const auto sw = obs_source_get_width(source), sh = obs_source_get_height(source);
    const auto size = fitSource(sw, sh, thumbnail ? 128 : 256, thumbnail ? 72 : 144);
    const uint32_t stride = (size.width * 3 + 3) & ~3u;
    std::vector<uint8_t> bmp(54 + stride * size.height);
    auto put = [&](size_t offset, uint32_t value) {
        for (int i = 0; i < 4; i++) bmp[offset + i] = static_cast<uint8_t>(value >> (8 * i));
    };
    bmp[0] = 'B'; bmp[1] = 'M'; put(2, static_cast<uint32_t>(bmp.size())); put(10, 54);
    put(14, 40); put(18, size.width); put(22, 0u - size.height); bmp[26] = 1; bmp[28] = 24;
    put(34, stride * size.height);
    obs_enter_graphics();
    auto *render = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
    auto *stage = gs_stagesurface_create(size.width, size.height, GS_BGRA);
    bool mapped = false, success = false;
    if (render && stage && gs_texrender_begin(render, size.width, size.height)) {
        vec4 clear{}; gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
        gs_ortho(0, static_cast<float>(sw), 0, static_cast<float>(sh), -100, 100);
        obs_source_video_render(source);
        gs_texrender_end(render);
        gs_stage_texture(stage, gs_texrender_get_texture(render));
        uint8_t *pixels = nullptr; uint32_t pitch = 0;
        mapped = gs_stagesurface_map(stage, &pixels, &pitch);
        if (mapped) {
            for (uint32_t y = 0; y < size.height; y++)
                for (uint32_t x = 0; x < size.width; x++)
                    std::copy_n(pixels + y * pitch + x * 4, 3, bmp.data() + 54 + y * stride + x * 3);
            success = true;
        }
    }
    if (mapped) gs_stagesurface_unmap(stage);
    if (stage) gs_stagesurface_destroy(stage);
    if (render) gs_texrender_destroy(render);
    obs_leave_graphics();
    if (!success) throw std::runtime_error("Preview image is unavailable.");
    return "data:image/bmp;base64," + base64(bmp);
}
