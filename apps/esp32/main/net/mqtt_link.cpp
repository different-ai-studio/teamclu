/*
 * SPDX-License-Identifier: MIT
 */
#include "mqtt_link.h"

#include <mooncake_log.h>
#include <mqtt_client.h>

#include <atomic>
#include <mutex>

namespace net {
namespace {

constexpr const char* kTag = "mqtt";

esp_mqtt_client_handle_t g_client = nullptr;
std::atomic<MqttState> g_state{MqttState::Idle};

std::mutex g_mutex;
std::string g_topic_mic, g_topic_spk, g_topic_ctl, g_topic_state;
std::function<void(const std::uint8_t*, std::size_t)> g_on_spk;
std::function<void(const char*, std::size_t)> g_on_ctl;

std::string base(const DeviceIdentity& id)
{
    return "amux/" + id.teamId + "/" + id.actorId + "/voice";
}

void handleEvent(void*, esp_event_base_t, std::int32_t event_id, void* event_data)
{
    auto* e = static_cast<esp_mqtt_event_handle_t>(event_data);

    switch (static_cast<esp_mqtt_event_id_t>(event_id)) {
        case MQTT_EVENT_CONNECTED: {
            g_state.store(MqttState::Connected);
            std::string spk, ctl, state;
            {
                std::lock_guard<std::mutex> lock(g_mutex);
                spk = g_topic_spk;
                ctl = g_topic_ctl;
                state = g_topic_state;
            }
            esp_mqtt_client_subscribe(g_client, spk.c_str(), 0);
            esp_mqtt_client_subscribe(g_client, ctl.c_str(), 1);
            // Retained presence, the counterpart of the LWT set at start().
            esp_mqtt_client_publish(g_client, state.c_str(), "{\"online\":true}", 0, 1, 1);
            mclog::tagInfo(kTag, "connected, subscribed spk+ctl");
            break;
        }

        case MQTT_EVENT_DISCONNECTED:
            // esp-mqtt reconnects on its own; this is not terminal.
            if (g_state.load() != MqttState::Rejected) {
                g_state.store(MqttState::Connecting);
            }
            mclog::tagWarn(kTag, "disconnected");
            break;

        case MQTT_EVENT_DATA: {
            std::function<void(const std::uint8_t*, std::size_t)> onSpk;
            std::function<void(const char*, std::size_t)> onCtl;
            std::string spk;
            {
                std::lock_guard<std::mutex> lock(g_mutex);
                onSpk = g_on_spk;
                onCtl = g_on_ctl;
                spk = g_topic_spk;
            }
            const bool isSpk = (e->topic_len == static_cast<int>(spk.size())) &&
                               (std::string(e->topic, e->topic_len) == spk);
            if (isSpk) {
                if (onSpk) {
                    onSpk(reinterpret_cast<const std::uint8_t*>(e->data), e->data_len);
                }
            } else if (onCtl) {
                onCtl(e->data, e->data_len);
            }
            break;
        }

        case MQTT_EVENT_ERROR: {
            // A refused CONNECT is not worth retrying: the credential is wrong
            // or expired, and esp-mqtt would otherwise hammer the broker
            // forever. The self-host amuxd is doing exactly that at ~100/s,
            // which is what this branch exists to avoid becoming.
            if (e->error_handle != nullptr &&
                e->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
                g_state.store(MqttState::Rejected);
                mclog::tagError(kTag, "connection refused (code {}); stopping",
                                static_cast<int>(e->error_handle->connect_return_code));
                esp_mqtt_client_stop(g_client);
            } else {
                mclog::tagWarn(kTag, "transport error");
            }
            break;
        }

        default:
            break;
    }
}

}  // namespace

const char* mqttStateName(MqttState s)
{
    switch (s) {
        case MqttState::Idle:       return "idle";
        case MqttState::Connecting: return "connecting";
        case MqttState::Connected:  return "connected";
        case MqttState::Rejected:   return "rejected";
    }
    return "?";
}

void mqttStart(const DeviceIdentity& id)
{
    if (g_client != nullptr) {
        return;
    }
    if (!id.valid() || id.broker.empty()) {
        mclog::tagError(kTag, "cannot start: identity incomplete");
        return;
    }

    const std::string b = base(id);
    std::string stateTopic = b + "/state";
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_topic_mic = b + "/mic";
        g_topic_spk = b + "/spk";
        g_topic_ctl = b + "/ctl";
        g_topic_state = stateTopic;
    }

    esp_mqtt_client_config_t cfg = {};
    cfg.broker.address.uri = id.broker.c_str();
    cfg.credentials.username = id.actorId.c_str();
    cfg.credentials.authentication.password = id.token.c_str();
    cfg.credentials.client_id = nullptr;  // esp-mqtt derives one from the MAC
    cfg.session.keepalive = 30;
    // Retained, so amuxd can tell a device that never connected from one that
    // dropped — the "电脑没醒着" / device-absent distinction the error screen needs.
    cfg.session.last_will.topic = stateTopic.c_str();
    cfg.session.last_will.msg = "{\"online\":false}";
    cfg.session.last_will.msg_len = 16;
    cfg.session.last_will.qos = 1;
    cfg.session.last_will.retain = 1;
    cfg.network.reconnect_timeout_ms = 5000;

    g_client = esp_mqtt_client_init(&cfg);
    if (g_client == nullptr) {
        mclog::tagError(kTag, "client init failed");
        return;
    }
    esp_mqtt_client_register_event(g_client, MQTT_EVENT_ANY, handleEvent, nullptr);
    g_state.store(MqttState::Connecting);
    if (esp_mqtt_client_start(g_client) != ESP_OK) {
        mclog::tagError(kTag, "client start failed");
        g_state.store(MqttState::Idle);
        return;
    }
    mclog::tagInfo(kTag, "connecting to {}", id.broker);
}

void mqttStop()
{
    if (g_client == nullptr) {
        return;
    }
    esp_mqtt_client_stop(g_client);
    esp_mqtt_client_destroy(g_client);
    g_client = nullptr;
    g_state.store(MqttState::Idle);
}

MqttState mqttState()
{
    return g_state.load();
}

void mqttOnSpk(std::function<void(const std::uint8_t*, std::size_t)> cb)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    g_on_spk = std::move(cb);
}

void mqttOnCtl(std::function<void(const char*, std::size_t)> cb)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    g_on_ctl = std::move(cb);
}

bool mqttPublishMic(const std::uint8_t* data, std::size_t len)
{
    if (g_client == nullptr || g_state.load() != MqttState::Connected) {
        return false;
    }
    std::string topic;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        topic = g_topic_mic;
    }
    // QoS 0, and non-blocking: a full outbox must drop the frame rather than
    // stall the audio pipeline waiting for the network.
    return esp_mqtt_client_publish(g_client, topic.c_str(),
                                   reinterpret_cast<const char*>(data),
                                   static_cast<int>(len), 0, 0) >= 0;
}

bool mqttPublishCtl(const std::string& json)
{
    if (g_client == nullptr || g_state.load() != MqttState::Connected) {
        return false;
    }
    std::string topic;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        topic = g_topic_ctl;
    }
    return esp_mqtt_client_publish(g_client, topic.c_str(), json.c_str(),
                                   static_cast<int>(json.size()), 1, 0) >= 0;
}

}  // namespace net
