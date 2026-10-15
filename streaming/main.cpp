// SPDX-License-Identifier: GPL-2.0-or-later
#include <obs.h>
#include <obs-audio-controls.h>
#include <util/base.h>
#include <util/bmem.h>
#include <util/windows/window-helpers.h>
#include "window-identity.hpp"
#include "preview-image.hpp"
#include "encoder-options.hpp"
#include <windows.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

struct Capture {
    std::string type, property, value, label, kind, id;
    HWND window = nullptr;
    DWORD pid = 0;
    uint64_t created = 0;
};
static std::vector<Capture> captures, audioTargets;
static std::string generation;
static Capture activeCapture, activeAudio;
static std::atomic<bool> audioLost{false};
static std::atomic<bool> videoLost{false};
static obs_output_t *output;
static obs_source_t *source, *audioSource;
static obs_scene_t *scene;
static obs_sceneitem_t *sceneItem;
static obs_encoder_t *videoEncoder, *audioEncoder;
static obs_service_t *service;
static std::atomic<bool> stopped{false};
static std::chrono::steady_clock::time_point started;
static std::vector<EncoderOption> encoderOptions;
static std::string preparedKey, selectedEncoder = "obs_x264";
static int videoBitrate = 8000, audioBitrate = 128;
static obs_volmeter_t *audioMeter;
static std::atomic<float> audioLevel{-60};
static std::atomic<uint64_t> audioLevelTime{0};

static void require(bool success, const char *message) { if (!success) throw std::runtime_error(message); }
static void reply(obs_data_t *data)
{
    std::string json = obs_data_get_json(data);
    json.erase(std::remove(json.begin(), json.end(), '\n'), json.end());
    json.erase(std::remove(json.begin(), json.end(), '\r'), json.end());
    std::cout << json << std::endl;
    obs_data_release(data);
}
static void windowUnhooked(void *data, calldata_t *)
{
    videoLost = true;
    obs_sceneitem_set_visible(static_cast<obs_sceneitem_t *>(data), false);
}
static void audioUnhooked(void *data, calldata_t *)
{
    audioLost = true;
    obs_source_set_audio_mixers(static_cast<obs_source_t *>(data), 0);
}
static void meterUpdated(void *, const float[], const float peak[], const float[])
{
    audioLevel = std::clamp(std::max(peak[0], peak[1]), -60.f, 0.f);
    audioLevelTime = GetTickCount64();
}
static void stop()
{
    if (output) {
        obs_output_stop(output);
        for (int i = 0; i < 100 && obs_output_active(output); i++)
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        obs_output_release(output); output = nullptr;
    }
    if (source && sceneItem) signal_handler_disconnect(obs_source_get_signal_handler(source), "unhooked", windowUnhooked, sceneItem);
    if (audioSource) signal_handler_disconnect(obs_source_get_signal_handler(audioSource), "unhooked", audioUnhooked, audioSource);
    if (audioMeter) { obs_volmeter_remove_callback(audioMeter, meterUpdated, nullptr); obs_volmeter_destroy(audioMeter); audioMeter = nullptr; }
    obs_set_output_source(0, nullptr); obs_set_output_source(1, nullptr);
    if (scene) { obs_scene_release(scene); scene = nullptr; }
    sceneItem = nullptr;
    if (source) { obs_source_release(source); source = nullptr; }
    if (audioSource) { obs_source_release(audioSource); audioSource = nullptr; }
    if (videoEncoder) { obs_encoder_release(videoEncoder); videoEncoder = nullptr; }
    if (audioEncoder) { obs_encoder_release(audioEncoder); audioEncoder = nullptr; }
    if (service) { obs_service_release(service); service = nullptr; }
    activeCapture = {}; activeAudio = {}; audioLost = false; videoLost = false;
    preparedKey.clear(); audioLevel = -60; audioLevelTime = 0;
}
static std::string defaultOutput()
{
    Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
    Microsoft::WRL::ComPtr<IMMDevice> device;
    LPWSTR id = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator))) ||
        FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device)) || FAILED(device->GetId(&id))) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, id, -1, nullptr, 0, nullptr, nullptr);
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, id, -1, result.data(), size, nullptr, nullptr);
    CoTaskMemFree(id);
    if (!result.empty()) result.pop_back();
    return result;
}
static bool outputAvailable(const std::string &id)
{
    Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
    Microsoft::WRL::ComPtr<IMMDevice> device;
    const int size = MultiByteToWideChar(CP_UTF8, 0, id.c_str(), -1, nullptr, 0);
    std::wstring wide(size, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, id.c_str(), -1, wide.data(), size);
    DWORD state = 0;
    return SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator))) &&
        SUCCEEDED(enumerator->GetDevice(wide.c_str(), &device)) && SUCCEEDED(device->GetState(&state)) && state == DEVICE_STATE_ACTIVE;
}
static bool resolveWindow(Capture &capture)
{
    // OBS selectors are title/class/executable tuples, not stable handles. Only
    // accept an unambiguous exact tuple, then bind audio to HWND + PID + birth time.
    struct Match { const char *title, *className, *exe; HWND window = nullptr; int count = 0; };
    char *className = nullptr, *title = nullptr, *exe = nullptr;
    ms_build_window_strings(capture.value.c_str(), &className, &title, &exe);
    Match match{title ? title : "", className ? className : "", exe ? exe : ""};
    EnumWindows([](HWND window, LPARAM data) -> BOOL {
        auto &m = *reinterpret_cast<Match *>(data);
        dstr title{}, className{}, exe{};
        ms_get_window_title(&title, window); ms_get_window_class(&className, window); ms_get_window_exe(&exe, window);
        if (title.array && className.array && exe.array && !_stricmp(title.array, m.title) &&
            !_stricmp(className.array, m.className) && !_stricmp(exe.array, m.exe)) { m.window = window; m.count++; }
        dstr_free(&title); dstr_free(&className); dstr_free(&exe);
        return TRUE;
    }, reinterpret_cast<LPARAM>(&match));
    bfree(className); bfree(title); bfree(exe);
    if (match.count != 1) return false;
    capture.window = match.window;
    GetWindowThreadProcessId(capture.window, &capture.pid);
    capture.created = processCreation(capture.pid);
    return sameWindow(capture.window, capture.pid, capture.created);
}
static void enumerate(std::vector<Capture> &targets, const char *unversioned, const char *property, const char *kind, const char *prefix)
{
    const auto *type = obs_get_latest_input_type_id(unversioned);
    if (!type) return;
    auto *properties = obs_get_source_properties(type);
    auto *list = obs_properties_get(properties, property);
    if (list) for (size_t i = 0; i < obs_property_list_item_count(list) && targets.size() < 256; i++) {
        const char *value = obs_property_list_item_string(list, i);
        if (!value || !*value || obs_property_list_item_disabled(list, i)) continue;
        if (std::string(kind) == "system" && std::string(value) == "default") continue;
        Capture target{type, property, value, std::string(prefix) + obs_property_list_item_name(list, i), kind};
        if ((target.kind == "window" || target.kind == "application") && !resolveWindow(target)) continue;
        targets.push_back(std::move(target));
    }
    obs_properties_destroy(properties);
}
static obs_data_t *listSources()
{
    require(!output, "Stop sharing before choosing another screen.");
    stop();
    captures.clear(); audioTargets.clear();
    GUID nonce{}; wchar_t text[40]{};
    require(SUCCEEDED(CoCreateGuid(&nonce)) && StringFromGUID2(nonce, text, 40), "Cannot create capture selection IDs.");
    generation.clear();
    for (const auto character : std::wstring(text)) generation.push_back(static_cast<char>(character)); // GUID text is ASCII.
    if (const auto *fixture = std::getenv("STRIFE_STREAM_TEST_FIXTURE"))
        captures.push_back({"ffmpeg_source", "local_file", fixture, "Generated test pattern", "screen"});
    else {
        enumerate(captures, "monitor_capture", "monitor_id", "screen", "Display: ");
        enumerate(captures, "window_capture", "window", "window", "Window: ");
    }
    enumerate(audioTargets, "wasapi_output_capture", "device_id", "system", "System — ");
    enumerate(audioTargets, "wasapi_process_output_capture", "window", "application", "Application — ");
    auto *result = obs_data_create();
    auto *audio = obs_data_array_create();
    std::string defaultAudio;
    const auto defaultDevice = defaultOutput();
    for (size_t i = 0; i < audioTargets.size(); i++) {
        auto &target = audioTargets[i];
        target.id = generation + "-audio-" + std::to_string(i);
        if (target.kind == "system" && target.value == defaultDevice) defaultAudio = target.id;
        auto *item = obs_data_create();
        obs_data_set_string(item, "id", target.id.c_str());
        obs_data_set_string(item, "name", target.label.c_str());
        obs_data_set_string(item, "kind", target.kind.c_str());
        obs_data_array_push_back(audio, item); obs_data_release(item);
    }
    obs_data_set_array(result, "audioTargets", audio); obs_data_array_release(audio);
    obs_data_set_int(result, "audioVersion", 1);
    auto *items = obs_data_array_create();
    for (size_t i = 0; i < captures.size(); i++) {
        auto &capture = captures[i];
        capture.id = generation + "-video-" + std::to_string(i);
        std::string automatic = capture.kind == "screen" ? defaultAudio : "";
        if (capture.kind == "window") for (const auto &target : audioTargets)
            if (target.window == capture.window && target.pid == capture.pid && target.created == capture.created) automatic = target.id;
        auto *item = obs_data_create();
        obs_data_set_string(item, "id", capture.id.c_str());
        obs_data_set_string(item, "name", capture.label.c_str());
        obs_data_set_string(item, "kind", capture.kind.c_str());
        obs_data_set_string(item, "automaticAudioId", automatic.c_str());
        obs_data_array_push_back(items, item); obs_data_release(item);
    }
    obs_data_set_array(result, "sources", items); obs_data_array_release(items);
    auto *encoders = obs_data_array_create();
    encoderOptions = probeEncoders();
    for (const auto &encoder : encoderOptions) {
        auto *entry = obs_data_create();
        obs_data_set_string(entry, "id", encoder.id.c_str());
        obs_data_set_string(entry, "name", encoder.name.c_str());
        obs_data_set_bool(entry, "available", encoder.available);
        obs_data_array_push_back(encoders, entry); obs_data_release(entry);
    }
    obs_data_set_array(result, "encoders", encoders); obs_data_array_release(encoders);
    obs_data_set_int(result, "qualityVersion", 3);
    obs_data_set_int(result, "previewVersion", 1);
    return result;
}
static void configureVideo(int width, int height, int fps)
{
    obs_video_info video{}; video.graphics_module = "libobs-d3d11"; video.fps_num = fps; video.fps_den = 1;
    video.base_width = video.output_width = width; video.base_height = video.output_height = height;
    video.output_format = VIDEO_FORMAT_NV12; video.gpu_conversion = true; video.colorspace = VIDEO_CS_709;
    video.range = VIDEO_RANGE_PARTIAL; video.scale_type = OBS_SCALE_BICUBIC;
    require(obs_reset_video(&video) == OBS_VIDEO_SUCCESS, "Graphics initialization failed for the selected quality.");
}
static int qualityInteger(obs_data_t *quality, const char *key, int minimum, int maximum)
{
    auto *item = obs_data_item_byname(quality, key);
    const bool integer = item && obs_data_item_numtype(item) == OBS_DATA_NUM_INT;
    obs_data_item_release(&item);
    const auto value = obs_data_get_int(quality, key);
    require(integer && value >= minimum && value <= maximum, "Invalid or unsupported streaming quality.");
    return static_cast<int>(value);
}
static void prepare(obs_data_t *request)
{
    require(!output, "A stream is already running.");
    auto *quality = obs_data_get_obj(request, "quality");
    require(quality != nullptr, "Choose a streaming quality preset.");
    int width, height, fps, bitrate;
    try {
        width = qualityInteger(quality, "width", 320, 3840);
        height = qualityInteger(quality, "height", 180, 2160);
        fps = qualityInteger(quality, "fps", 15, 60);
        bitrate = qualityInteger(quality, "bitrateKbps", 500, 40000);
        require(width % 2 == 0 && height % 2 == 0 && (fps == 15 || fps == 30 || fps == 60),
            "Invalid or unsupported streaming quality.");
    } catch (...) { obs_data_release(quality); throw; }
    obs_data_release(quality);
    const int requestedAudioBitrate = obs_data_has_user_value(request, "audioBitrateKbps")
        ? qualityInteger(request, "audioBitrateKbps", 64, 192) : 128;
    require(requestedAudioBitrate == 64 || requestedAudioBitrate == 96 || requestedAudioBitrate == 128 ||
        requestedAudioBitrate == 160 || requestedAudioBitrate == 192, "Unsupported audio bitrate.");
    require(bitrate % 100 == 0, "Video bitrate must use 100 Kbps increments.");
    const std::string encoderId = obs_data_has_user_value(request, "encoderId") ? obs_data_get_string(request, "encoderId") : "obs_x264";
    require(std::any_of(encoderOptions.begin(), encoderOptions.end(), [&](const auto &e) {
        return e.id == encoderId && e.available; }), "The selected encoder is unavailable. Choose another encoder.");
    const std::string id = obs_data_get_string(request, "sourceId");
    const auto found = std::find_if(captures.begin(), captures.end(), [&](const auto &c) { return c.id == id; });
    require(found != captures.end(), "Choose a capture source again.");
    const auto &capture = *found;
    require(!capture.window || sameWindow(capture.window, capture.pid, capture.created), "The selected window closed. Choose again.");
    auto *audioField = obs_data_item_byname(request, "audioId");
    const bool validAudioField = audioField && obs_data_item_gettype(audioField) == OBS_DATA_STRING;
    obs_data_item_release(&audioField);
    require(validAudioField, "Choose audio explicitly, or disable audio.");
    const std::string audioId = obs_data_get_string(request, "audioId");
    const Capture *audio = nullptr;
    if (!audioId.empty()) {
        const auto target = std::find_if(audioTargets.begin(), audioTargets.end(), [&](const auto &a) { return a.id == audioId; });
        require(target != audioTargets.end(), "Choose an audio target again.");
        audio = &*target;
        require(audio->kind == "system" ? outputAvailable(audio->value) : sameWindow(audio->window, audio->pid, audio->created),
            "The selected audio target is unavailable. Choose another target or disable audio.");
    }
    const std::string key = id + "|" + audioId + "|" + encoderId + "|" + std::to_string(width) + "|" +
        std::to_string(height) + "|" + std::to_string(fps) + "|" + std::to_string(bitrate) + "|" + std::to_string(requestedAudioBitrate);
    if (source && key == preparedKey && !videoLost && !audioLost) return;
    stop();
    activeCapture = capture;
    selectedEncoder = encoderId; videoBitrate = bitrate; audioBitrate = requestedAudioBitrate;
    configureVideo(width, height, fps);
    auto *settings = obs_data_create();
    obs_data_set_string(settings, capture.property.c_str(), capture.value.c_str());
    obs_data_set_bool(settings, "cursor", true);
    obs_data_set_bool(settings, "force_sdr", true);
    obs_data_set_bool(settings, "capture_audio", false);
    obs_data_set_bool(settings, "is_local_file", true);
    obs_data_set_bool(settings, "looping", true);
    source = obs_source_create(capture.type.c_str(), "Shared screen", settings, nullptr);
    obs_data_release(settings);
    require(source != nullptr, "The selected window or display is unavailable.");
    obs_source_set_audio_mixers(source, 0); // Video never implicitly contributes application/fixture audio.
    scene = obs_scene_create("Strife share");
    auto *item = obs_scene_add(scene, source);
    sceneItem = item;
    if (capture.kind == "window") {
        // Hide synchronously before OBS can search for a replacement window.
        signal_handler_connect(obs_source_get_signal_handler(source), "unhooked", windowUnhooked, item);
    }
    vec2 bounds{static_cast<float>(width), static_cast<float>(height)};
    obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_MAX_ONLY);
    obs_sceneitem_set_bounds(item, &bounds);
    obs_set_output_source(0, obs_scene_get_source(scene));
    if (audio) {
        activeAudio = *audio; audioLost = false;
        settings = obs_data_create();
        obs_data_set_string(settings, audio->property.c_str(), audio->value.c_str());
        obs_data_set_int(settings, "strife_window", reinterpret_cast<uintptr_t>(audio->window));
        obs_data_set_int(settings, "strife_pid", audio->pid);
        obs_data_set_int(settings, "strife_created", audio->created);
        audioSource = obs_source_create(audio->type.c_str(), "Selected audio", settings, nullptr);
        obs_data_release(settings);
        require(audioSource != nullptr, "The selected audio target could not be opened.");
        if (audio->kind == "application")
            signal_handler_connect(obs_source_get_signal_handler(audioSource), "unhooked", audioUnhooked, audioSource);
        obs_set_output_source(1, audioSource);
        if (audio->kind == "application") {
            bool hooked = false;
            for (int i = 0; i < 150 && !hooked && !audioLost; i++) {
                calldata_t state{};
                proc_handler_call(obs_source_get_proc_handler(audioSource), "get_hooked", &state);
                hooked = calldata_bool(&state, "hooked"); calldata_free(&state);
                if (!hooked) std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
            require(hooked && !audioLost, "Application audio could not be opened. Choose another target or disable audio.");
        }
        audioMeter = obs_volmeter_create(OBS_FADER_LOG);
        require(audioMeter && obs_volmeter_attach_source(audioMeter, audioSource), "Audio level meter could not be opened.");
        obs_volmeter_add_callback(audioMeter, meterUpdated, nullptr);
    }
    // Catch vanished/minimized windows before publishing a black stream.
    for (int i = 0; i < 100 && (!obs_source_get_width(source) || !obs_source_get_height(source)); i++)
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    require(obs_source_get_width(source) > 0 && obs_source_get_height(source) > 0, "The source has no image. Restore the window and try again.");
    const auto actual = fitSource(obs_source_get_width(source), obs_source_get_height(source), width, height);
    configureVideo(actual.width, actual.height, fps);
    bounds = {static_cast<float>(actual.width), static_cast<float>(actual.height)};
    obs_sceneitem_set_bounds(item, &bounds);
    auto *videoSettings = encoderSettings(selectedEncoder, videoBitrate);
    videoEncoder = obs_video_encoder_create(selectedEncoder.c_str(), "Share video", videoSettings, nullptr);
    obs_data_release(videoSettings);
    require(videoEncoder != nullptr, "The selected video encoder is unavailable.");
    obs_encoder_set_video(videoEncoder, obs_get_video());
    require(initializeBaseline(videoEncoder), "The encoder cannot produce this quality as H.264 Baseline. Choose another encoder or quality.");
    // Do not reuse an encoder whose lookahead/timestamp state belonged to the
    // counting sink. Preserve only its validated settings/SPS for publication.
    auto *validatedSettings = obs_encoder_get_settings(videoEncoder);
    obs_encoder_release(videoEncoder);
    videoEncoder = obs_video_encoder_create(selectedEncoder.c_str(), "Share video", validatedSettings, nullptr);
    obs_data_release(validatedSettings);
    require(videoEncoder != nullptr, "The selected video encoder could not be prepared.");
    obs_encoder_set_video(videoEncoder, obs_get_video());
    preparedKey = key;
}
static void start(obs_data_t *request)
{
    prepare(request);
    service = obs_service_create("whip_custom", "Strife room", request, nullptr);
    auto *audioSettings = obs_data_create(); obs_data_set_int(audioSettings, "bitrate", audioBitrate);
    if (audioSource) audioEncoder = obs_audio_encoder_create("ffmpeg_opus", "Share audio", audioSettings, 0, nullptr);
    obs_data_release(audioSettings);
    require(service && videoEncoder && (!audioSource || audioEncoder), "Streaming encoders are unavailable.");
    if (audioEncoder) obs_encoder_set_audio(audioEncoder, obs_get_audio());
    output = obs_output_create(audioSource ? "whip_output" : "whip_output_video", "Strife WHIP", nullptr, nullptr);
    require(output != nullptr, "WHIP output is unavailable.");
    obs_output_set_service(output, service);
    obs_output_set_video_encoder(output, videoEncoder);
    if (audioEncoder) obs_output_set_audio_encoder(output, audioEncoder, 0);
    stopped = false;
    signal_handler_connect(obs_output_get_signal_handler(output), "stop", [](void *, calldata_t *) { stopped = true; }, nullptr);
    started = std::chrono::steady_clock::now();
    require(obs_output_start(output), "Could not start the stream.");
}
static const char *status()
{
    if (!source) return "idle";
    if (videoLost || (activeCapture.window && !sameWindow(activeCapture.window, activeCapture.pid, activeCapture.created))) { stop(); return "error"; }
    if (audioSource && (audioLost || (activeAudio.kind == "system" ? !outputAvailable(activeAudio.value) :
        !sameWindow(activeAudio.window, activeAudio.pid, activeAudio.created)))) {
        audioLost = true; obs_source_set_audio_mixers(audioSource, 0);
    }
    if (!output) return "preview";
    if (stopped || (std::chrono::steady_clock::now() - started > std::chrono::seconds(20) && !obs_output_get_total_bytes(output))) {
        stop(); return "error";
    }
    return obs_output_get_total_bytes(output) > 0 ? "streaming" : "starting";
}
int main()
{
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    base_set_log_handler([](int, const char *format, va_list args, void *) { vfprintf(stderr, format, args); fputc('\n', stderr); }, nullptr);
    bool initialized = false;
    std::filesystem::path moduleConfig;
    bool ownsConfig = false;
    try {
        GUID configId{}; wchar_t configText[40]{};
        require(SUCCEEDED(CoCreateGuid(&configId)) && StringFromGUID2(configId, configText, 40), "Cannot create capture configuration identity.");
        moduleConfig = std::filesystem::temp_directory_path() / (std::wstring(L"strife-stream-") + configText);
        ownsConfig = std::filesystem::create_directory(moduleConfig);
        require(ownsConfig, "Cannot create private capture configuration.");
        require(obs_startup("en-US", moduleConfig.u8string().c_str(), nullptr), "OBS initialization failed."); initialized = true;
        registerEncoderProbe();
        obs_audio_info audio{48000, SPEAKERS_STEREO}; require(obs_reset_audio(&audio), "Audio initialization failed.");
        configureVideo(1920, 1080, 60);
        for (const auto *name : {"obs-webrtc", "obs-x264", "obs-ffmpeg", "win-capture", "win-wasapi"}) {
            obs_module_t *module = nullptr;
            require(obs_open_module(&module, (std::string("../../obs-plugins/64bit/") + name + ".dll").c_str(),
                (std::string("../../data/obs-plugins/") + name).c_str()) == MODULE_SUCCESS && obs_init_module(module), "A required capture plugin is missing.");
        }
        for (const auto *name : {"obs-nvenc", "obs-qsv11"}) {
            obs_module_t *module = nullptr;
            if (obs_open_module(&module, (std::string("../../obs-plugins/64bit/") + name + ".dll").c_str(),
                (std::string("../../data/obs-plugins/") + name).c_str()) == MODULE_SUCCESS) obs_init_module(module);
        }
        obs_post_load_modules();
        const auto audioVersion = reinterpret_cast<int (*)()>(GetProcAddress(GetModuleHandleW(L"win-wasapi.dll"), "strife_audio_identity_version"));
        const auto whipVersion = reinterpret_cast<int (*)()>(GetProcAddress(GetModuleHandleW(L"obs-webrtc.dll"), "strife_whip_quality_version"));
        require(audioVersion && audioVersion() == 1 && whipVersion && whipVersion() == 3,
            "Streaming modules are stale. Rebuild the Strife streaming payload.");
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.size() > 32768) break;
            auto *request = obs_data_create_from_json(line.c_str());
            auto *result = obs_data_create();
            std::string command;
            try {
                require(request != nullptr, "Invalid command.");
                command = obs_data_get_string(request, "command");
                if (command == "sources") { obs_data_release(result); result = listSources(); }
                else if (command == "start") start(request);
                else if (command == "preview" || command == "thumbnail") {
                    prepare(request);
                    obs_data_set_string(result, "image", previewImage(source, command == "thumbnail").c_str());
                    if (command == "thumbnail") stop();
                }
                else if (command == "stop") stop();
                else require(command == "status", "Unknown command.");
                const auto *state = status(); obs_data_set_string(result, "status", state);
                if (std::string(state) == "error") obs_data_set_string(result, "error", "The stream ended. Check the room, connection, and publishing session.");
                if (audioLost) obs_data_set_string(result, "audioWarning", "Audio target lost; audio is muted. Stop and choose audio again.");
                obs_data_set_double(result, "audioLevelDb", audioSource && !audioLost && GetTickCount64() - audioLevelTime < 1000 ? audioLevel.load() : -60);
                if (videoEncoder) {
                    obs_video_info video{}; obs_get_video_info(&video);
                    auto *quality = obs_data_create();
                    auto *settings = obs_encoder_get_settings(videoEncoder);
                    obs_data_set_int(quality, "width", video.output_width);
                    obs_data_set_int(quality, "height", video.output_height);
                    obs_data_set_int(quality, "fps", video.fps_num / video.fps_den);
                    obs_data_set_int(quality, "bitrateKbps", obs_data_get_int(settings, "bitrate"));
                    obs_data_set_obj(result, "quality", quality);
                    obs_data_release(settings); obs_data_release(quality);
                    obs_data_set_string(result, "encoderId", selectedEncoder.c_str());
                    obs_data_set_int(result, "audioBitrateKbps", audioEncoder || audioMeter ? audioBitrate : 0);
                }
                if (output) {
                    auto *performance = obs_data_create();
                    obs_data_set_double(performance, "renderFps", obs_get_active_fps());
                    obs_data_set_double(performance, "renderTimeMs", obs_get_average_frame_time_ns() / 1000000.0);
                    obs_data_set_int(performance, "renderLaggedFrames", obs_get_lagged_frames());
                    obs_data_set_int(performance, "outputFrames", obs_output_get_total_frames(output));
                    obs_data_set_int(performance, "outputDroppedFrames", obs_output_get_frames_dropped(output));
                    obs_data_set_obj(result, "performance", performance); obs_data_release(performance);
                }
                obs_data_set_bool(result, "ok", true);
            } catch (const std::exception &error) {
                if (!output || (command != "preview" && command != "thumbnail")) stop();
                obs_data_set_bool(result, "ok", false); obs_data_set_string(result, "error", error.what());
            }
            obs_data_release(request); reply(result);
        }
    } catch (const std::exception &error) {
        auto *result = obs_data_create(); obs_data_set_bool(result, "ok", false); obs_data_set_string(result, "error", error.what()); reply(result);
    }
    if (initialized) { stop(); obs_shutdown(); }
    if (ownsConfig) { std::error_code ignored; std::filesystem::remove_all(moduleConfig, ignored); }
    CoUninitialize();
}
