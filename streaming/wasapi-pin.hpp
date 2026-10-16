// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <obs.h>
#include "window-identity.hpp"

// Used only by Strife's private copy of the WASAPI module. Never let OBS's
// reconnect-by-title behavior move application audio to a replacement process.
inline HWND strifeAudioWindow(obs_source_t *source)
{
    auto *settings = obs_source_get_settings(source);
    const auto window = reinterpret_cast<HWND>(static_cast<uintptr_t>(obs_data_get_int(settings, "strife_window")));
    const auto pid = static_cast<DWORD>(obs_data_get_int(settings, "strife_pid"));
    const auto created = static_cast<uint64_t>(obs_data_get_int(settings, "strife_created"));
    obs_data_release(settings);
    if (!sameWindow(window, pid, created)) throw "The selected Strife audio application is no longer available.";
    return window;
}
