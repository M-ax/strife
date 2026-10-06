// SPDX-License-Identifier: GPL-2.0-or-later
#include <obs.h>
#include <util/base.h>
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

struct Capture { std::string type, property, value, label; };
static std::vector<Capture> captures;
static obs_output_t *output;
static obs_source_t *source, *audioSource;
static obs_scene_t *scene;
static obs_encoder_t *videoEncoder, *audioEncoder;
static obs_service_t *service;
static std::atomic<bool> stopped{false};
static std::chrono::steady_clock::time_point started;

static void require(bool success, const char *message) { if (!success) throw std::runtime_error(message); }
static void reply(obs_data_t *data)
{
    std::string json = obs_data_get_json(data);
    json.erase(std::remove(json.begin(), json.end(), '\n'), json.end());
    json.erase(std::remove(json.begin(), json.end(), '\r'), json.end());
    std::cout << json << std::endl;
    obs_data_release(data);
}
static void stop()
{
    if (output) {
        obs_output_stop(output);
        for (int i = 0; i < 100 && obs_output_active(output); i++)
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        obs_output_release(output); output = nullptr;
    }
    obs_set_output_source(0, nullptr); obs_set_output_source(1, nullptr);
    if (scene) { obs_scene_release(scene); scene = nullptr; }
    if (source) { obs_source_release(source); source = nullptr; }
    if (audioSource) { obs_source_release(audioSource); audioSource = nullptr; }
    if (videoEncoder) { obs_encoder_release(videoEncoder); videoEncoder = nullptr; }
    if (audioEncoder) { obs_encoder_release(audioEncoder); audioEncoder = nullptr; }
    if (service) { obs_service_release(service); service = nullptr; }
}
static void enumerate(const char *unversioned, const char *property, const char *prefix)
{
    const auto *type = obs_get_latest_input_type_id(unversioned);
    if (!type) return;
    auto *properties = obs_get_source_properties(type);
    auto *list = obs_properties_get(properties, property);
    if (list) for (size_t i = 0; i < obs_property_list_item_count(list) && captures.size() < 256; i++) {
        const char *value = obs_property_list_item_string(list, i);
        if (!value || !*value || obs_property_list_item_disabled(list, i)) continue;
        captures.push_back({type, property, value, std::string(prefix) + obs_property_list_item_name(list, i)});
    }
    obs_properties_destroy(properties);
}
static obs_data_t *listSources()
{
    require(!output, "Stop sharing before choosing another screen.");
    captures.clear();
    if (const auto *fixture = std::getenv("STRIFE_STREAM_TEST_FIXTURE"))
        captures.push_back({"ffmpeg_source", "local_file", fixture, "Generated test pattern"});
    else {
        enumerate("monitor_capture", "monitor_id", "Display: ");
        enumerate("window_capture", "window", "Window: ");
    }
    auto *result = obs_data_create();
    auto *items = obs_data_array_create();
    for (size_t i = 0; i < captures.size(); i++) {
        auto *item = obs_data_create();
        obs_data_set_string(item, "id", std::to_string(i).c_str());
        obs_data_set_string(item, "name", captures[i].label.c_str());
        obs_data_array_push_back(items, item); obs_data_release(item);
    }
    obs_data_set_array(result, "sources", items); obs_data_array_release(items);
    return result;
}
static void start(obs_data_t *request)
{
    require(!output, "A stream is already running.");
    const std::string id = obs_data_get_string(request, "sourceId");
    require(!id.empty() && id.size() < 4 && id.find_first_not_of("0123456789") == std::string::npos, "Invalid capture source.");
    const auto index = std::stoul(id);
    require(index < captures.size(), "Choose a capture source again.");
    const auto &capture = captures[index];
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
    scene = obs_scene_create("Strife share");
    auto *item = obs_scene_add(scene, source);
    vec2 bounds{1280.f, 720.f};
    obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_SCALE_INNER);
    obs_sceneitem_set_bounds(item, &bounds);
    obs_set_output_source(0, obs_scene_get_source(scene));
    if (obs_data_get_bool(request, "audio")) {
        settings = obs_data_create(); obs_data_set_string(settings, "device_id", "default");
        audioSource = obs_source_create("wasapi_output_capture", "System audio", settings, nullptr);
        obs_data_release(settings);
        require(audioSource != nullptr, "System audio could not be opened.");
        obs_set_output_source(1, audioSource);
    }
    // Catch vanished/minimized windows before publishing a black stream.
    for (int i = 0; i < 100 && (!obs_source_get_width(source) || !obs_source_get_height(source)); i++)
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    require(obs_source_get_width(source) > 0 && obs_source_get_height(source) > 0, "The source has no image. Restore the window and try again.");
    service = obs_service_create("whip_custom", "Strife room", request, nullptr);
    auto *videoSettings = obs_data_create_from_json("{\"bitrate\":3000,\"preset\":\"veryfast\",\"profile\":\"baseline\",\"rate_control\":\"CBR\",\"keyint_sec\":2,\"bf\":0,\"repeat_headers\":true}");
    auto *audioSettings = obs_data_create_from_json("{\"bitrate\":128}");
    videoEncoder = obs_video_encoder_create("obs_x264", "Share video", videoSettings, nullptr);
    audioEncoder = obs_audio_encoder_create("ffmpeg_opus", "Share audio", audioSettings, 0, nullptr);
    obs_data_release(videoSettings); obs_data_release(audioSettings);
    require(service && videoEncoder && audioEncoder, "Streaming encoders are unavailable.");
    obs_encoder_set_video(videoEncoder, obs_get_video()); obs_encoder_set_audio(audioEncoder, obs_get_audio());
    output = obs_output_create("whip_output", "Strife WHIP", nullptr, nullptr);
    require(output != nullptr, "WHIP output is unavailable.");
    obs_output_set_service(output, service);
    obs_output_set_video_encoder(output, videoEncoder); obs_output_set_audio_encoder(output, audioEncoder, 0);
    stopped = false;
    signal_handler_connect(obs_output_get_signal_handler(output), "stop", [](void *, calldata_t *) { stopped = true; }, nullptr);
    started = std::chrono::steady_clock::now();
    require(obs_output_start(output), "Could not start the stream.");
}
static const char *status()
{
    if (!output) return "idle";
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
    try {
        require(obs_startup("en-US", nullptr, nullptr), "OBS initialization failed."); initialized = true;
        obs_audio_info audio{48000, SPEAKERS_STEREO}; require(obs_reset_audio(&audio), "Audio initialization failed.");
        obs_video_info video{}; video.graphics_module = "libobs-d3d11"; video.fps_num = 30; video.fps_den = 1;
        video.base_width = video.output_width = 1280; video.base_height = video.output_height = 720;
        video.output_format = VIDEO_FORMAT_NV12; video.gpu_conversion = true; video.colorspace = VIDEO_CS_709;
        video.range = VIDEO_RANGE_PARTIAL; video.scale_type = OBS_SCALE_BICUBIC;
        require(obs_reset_video(&video) == OBS_VIDEO_SUCCESS, "Graphics initialization failed.");
        for (const auto *name : {"obs-webrtc", "obs-x264", "obs-ffmpeg", "win-capture", "win-wasapi"}) {
            obs_module_t *module = nullptr;
            require(obs_open_module(&module, (std::string("../../obs-plugins/64bit/") + name + ".dll").c_str(),
                (std::string("../../data/obs-plugins/") + name).c_str()) == MODULE_SUCCESS && obs_init_module(module), "A required capture plugin is missing.");
        }
        obs_post_load_modules();
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.size() > 32768) break;
            auto *request = obs_data_create_from_json(line.c_str());
            auto *result = obs_data_create();
            try {
                require(request != nullptr, "Invalid command.");
                std::string command = obs_data_get_string(request, "command");
                if (command == "sources") { obs_data_release(result); result = listSources(); }
                else if (command == "start") start(request);
                else if (command == "stop") stop();
                else require(command == "status", "Unknown command.");
                const auto *state = status(); obs_data_set_string(result, "status", state);
                if (std::string(state) == "error") obs_data_set_string(result, "error", "The stream ended. Check the room, connection, and publishing session.");
                obs_data_set_bool(result, "ok", true);
            } catch (const std::exception &error) { stop(); obs_data_set_bool(result, "ok", false); obs_data_set_string(result, "error", error.what()); }
            obs_data_release(request); reply(result);
        }
    } catch (const std::exception &error) {
        auto *result = obs_data_create(); obs_data_set_bool(result, "ok", false); obs_data_set_string(result, "error", error.what()); reply(result);
    }
    if (initialized) { stop(); obs_shutdown(); }
    CoUninitialize();
}
