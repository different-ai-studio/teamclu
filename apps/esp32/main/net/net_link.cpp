/*
 * SPDX-License-Identifier: MIT
 */
#include "net_link.h"

#include "device_token.h"
#include "mqtt_link.h"

#include <mooncake_log.h>
#include <ssid_manager.h>
#include <esp_wifi.h>
#include <wifi_manager.h>

#include <atomic>
#include <mutex>

namespace net {
namespace {

constexpr const char* kTag = "net";

std::atomic<face::Link> g_link{face::Link::Booting};

// Set by the Wi-Fi event task, consumed by poll() on the main loop. The event
// callback must do nothing but flip flags — see poll() in the header.
std::atomic<bool> g_want_mqtt{false};
std::atomic<bool> g_mqtt_started{false};

// Written from the Wi-Fi event task, read from the main loop.
std::mutex g_mutex;
std::string g_ip;
std::string g_ssid;
std::string g_ap_ssid;

// Called from the Wi-Fi event task. Deliberately silent: formatting a log line
// here costs several hundred bytes of stack on a task that has little to spare,
// and the transition is logged from poll() instead.
void setLink(face::Link l)
{
    g_link.store(l);
}

}  // namespace

bool hasSavedCredentials()
{
    return !SsidManager::GetInstance().GetSsidList().empty();
}

bool isBound()
{
    DeviceIdentity id;
    return loadDeviceIdentity(id);
}

void forgetProvisioning()
{
    SsidManager::GetInstance().Clear();
    clearDeviceToken();
    mclog::tagWarn(kTag, "provisioning wiped; will start config AP");
}

void start(const std::string& deviceCode)
{
    auto& wifi = WifiManager::GetInstance();

    WifiManagerConfig cfg;
    // Matches what the wifi screen prints, so the user can tell which access
    // point is theirs when several devices are being set up at once.
    cfg.ssid_prefix = "TeamClu-" + deviceCode;
    cfg.language = "zh-CN";

    wifi.SetEventCallback([](WifiEvent e, const std::string& data) {
        auto& w = WifiManager::GetInstance();
        switch (e) {
            case WifiEvent::Scanning:
            case WifiEvent::Connecting:
                setLink(face::Link::Connecting);
                break;
            case WifiEvent::Connected: {
                // Flags only. Reading the IP/SSID allocates std::strings, so
                // even that is deferred to poll() on the main task.
                g_want_mqtt.store(true);
                setLink(face::Link::Online);
                break;
            }
            case WifiEvent::Disconnected:
                // Not ConfigAp: the component retries with backoff, and dropping
                // into provisioning on a transient drop would be hostile.
                setLink(face::Link::Connecting);
                break;
            case WifiEvent::ConfigModeEnter: {
                setLink(face::Link::ConfigAp);
                break;
            }
            case WifiEvent::ConfigModeExit:
                setLink(face::Link::Connecting);
                break;
        }
        (void)data;
    });

    if (!wifi.Initialize(cfg)) {
        mclog::tagError(kTag, "wifi init failed");
        return;
    }

    // Regulatory domain. Unset, ESP-IDF uses "01" (world safe mode), which
    // permits only channels 1-11 — so an AP sitting on 12 or 13, which is legal
    // here and which phone hotspots do pick, is invisible to the radio no
    // matter how strong it is. That presents as an endless "No AP found" for a
    // network the user can plainly see on their phone.
    if (esp_wifi_set_country_code("CN", true) != ESP_OK) {
        mclog::tagWarn(kTag, "could not set country code; channels 12-13 stay invisible");
    }

    // Modem sleep is OFF for now, deliberately.
    //
    // BALANCED (WIFI_PS_MIN_MODEM) was the obvious choice for a battery device
    // with bursty voice traffic, and it is what this used to do. On a phone
    // hotspot it produced an endless connect/disconnect cycle: the station
    // associates, then sleeps past what the AP is willing to buffer, and gets
    // dropped. Correctness first — a device that saves power by falling off the
    // network is not saving anything.
    //
    // Revisit once the link is stable and the power tiers have been measured on
    // hardware; the right answer is probably MIN_MODEM against a real router
    // and NONE against a hotspot, chosen at runtime.
    wifi.SetPowerSaveLevel(WifiPowerSaveLevel::PERFORMANCE);

    if (hasSavedCredentials()) {
        // Name them. esp-wifi-connect logs "No AP found" without saying what it
        // was looking for, which makes a typo, a stale network and a 5 GHz-only
        // AP all look identical from the console.
        for (const auto& item : SsidManager::GetInstance().GetSsidList()) {
            mclog::tagInfo(kTag, "saved network: \"{}\" (pw {} chars)", item.ssid,
                           item.password.size());
        }
        mclog::tagInfo(kTag, "credentials present, connecting");
        setLink(face::Link::Connecting);
        wifi.StartStation();
    } else {
        mclog::tagInfo(kTag, "no credentials, starting config ap");
        wifi.StartConfigAp();
    }
}

void poll()
{
    // Log link transitions from here: the event task cannot afford to format.
    static face::Link s_reported = face::Link::Booting;
    const face::Link now = g_link.load();
    if (now != s_reported) {
        mclog::tagInfo(kTag, "link {} -> {}", face::linkName(s_reported), face::linkName(now));
        s_reported = now;
    }

    if (!g_want_mqtt.load() || g_mqtt_started.load()) {
        return;
    }
    g_mqtt_started.store(true);

    {
        auto& w = WifiManager::GetInstance();
        std::lock_guard<std::mutex> lock(g_mutex);
        g_ssid = w.GetSsid();
        g_ip = w.GetIpAddress();
        mclog::tagInfo(kTag, "connected ssid={} ip={}", g_ssid, g_ip);
    }

    DeviceIdentity id;
    if (loadDeviceIdentity(id)) {
        mclog::tagInfo(kTag, "bound to team={} actor={}", id.teamId, id.actorId);
        mqttStart(id);
    } else {
        mclog::tagWarn(kTag, "online but unbound: no device token stored");
    }
}

face::Link linkState()
{
    return g_link.load();
}

std::string ipAddress()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_ip;
}

std::string ssid()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_ssid;
}

std::string apSsid()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_ap_ssid;
}

}  // namespace net
