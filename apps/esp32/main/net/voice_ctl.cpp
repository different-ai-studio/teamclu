/*
 * SPDX-License-Identifier: MIT
 */
#include "voice_ctl.h"

#include <esp_random.h>
#include <mooncake_log.h>

#include <atomic>
#include <cstdio>
#include <deque>
#include <mutex>
#include <string>

#include "mqtt_link.h"

namespace net {
namespace {

constexpr const char* kTag = "ctl";

std::atomic<std::uint64_t> g_seq{0};
std::atomic<std::uint32_t> g_boot_id{0};

// Escapes the few characters that would otherwise break the JSON. Device error
// messages are our own strings today, but they are the one field that could
// grow to carry something from outside, and a malformed ctl is dropped by
// amuxd's parser with only a warning — a silent failure worth not risking.
void appendEscaped(char* out, std::size_t cap, const char* in)
{
    std::size_t o = 0;
    for (const char* p = in; *p != '\0' && o + 7 < cap; ++p) {
        const unsigned char c = static_cast<unsigned char>(*p);
        switch (c) {
            case '"':  out[o++] = '\\'; out[o++] = '"'; break;
            case '\\': out[o++] = '\\'; out[o++] = '\\'; break;
            case '\n': out[o++] = '\\'; out[o++] = 'n'; break;
            case '\r': out[o++] = '\\'; out[o++] = 'r'; break;
            case '\t': out[o++] = '\\'; out[o++] = 't'; break;
            default:
                if (c < 0x20) {
                    o += static_cast<std::size_t>(std::snprintf(out + o, cap - o, "\\u%04x", c));
                } else {
                    out[o++] = static_cast<char>(c);
                }
        }
    }
    out[o] = '\0';
}

bool publish(const char* json)
{
    if (!mqttPublishCtl(json)) {
        mclog::tagWarn(kTag, "ctl dropped (mqtt not connected): {}", json);
        return false;
    }
    mclog::tagInfo(kTag, "-> {}", json);
    return true;
}

}  // namespace

// Incoming inbox. Mutex-guarded deque: ctl is rare (a handful per turn) so a
// lock per push/pop is cheaper than a lock-free ring and never the audio path.
// Bounded to cap memory under a flood / a main loop that has died — the face
// shows whatever error the oldest surviving message carries, which is the
// right behavior if the device is overwhelmed.
struct IncomingInbox {
    std::mutex mutex;
    std::deque<IncomingCtl> queue;
    static constexpr std::size_t kCap = 16;
};
IncomingInbox g_inbox;

std::uint64_t ctlSeq()
{
    return g_seq.load();
}

void initBootId()
{
    if (g_boot_id.load() != 0) {
        return;
    }
    std::uint32_t id = 0;
    do {
        esp_fill_random(&id, sizeof(id));
    } while (id == 0);
    g_boot_id.store(id);
    mclog::tagInfo(kTag, "boot_id={:08x}", id);
}

std::uint32_t bootId()
{
    return g_boot_id.load();
}

bool sendTurnStart(face::Mode mode)
{
    if (bootId() == 0) {
        initBootId();
    }
    char buf[160];
    std::snprintf(buf, sizeof(buf),
                  R"({"type":"turn_start","intent":"%s","seq":%llu,"boot_id":"%08lx"})",
                  mode == face::Mode::Chat ? "chat" : "note",
                  static_cast<unsigned long long>(++g_seq),
                  static_cast<unsigned long>(bootId()));
    return publish(buf);
}

bool sendTurnEnd()
{
    char buf[96];
    std::snprintf(buf, sizeof(buf), R"({"type":"turn_end","seq":%llu})",
                  static_cast<unsigned long long>(++g_seq));
    return publish(buf);
}

bool sendBargeIn()
{
    char buf[96];
    std::snprintf(buf, sizeof(buf), R"({"type":"barge_in","seq":%llu})",
                  static_cast<unsigned long long>(++g_seq));
    return publish(buf);
}

bool sendError(const char* code, const char* message)
{
    char esc_code[48];
    char esc_msg[160];
    appendEscaped(esc_code, sizeof(esc_code), code == nullptr ? "unknown" : code);
    appendEscaped(esc_msg, sizeof(esc_msg), message == nullptr ? "" : message);

    char buf[288];
    std::snprintf(buf, sizeof(buf),
                  R"({"type":"error","code":"%s","message":"%s","seq":%llu})", esc_code, esc_msg,
                  static_cast<unsigned long long>(++g_seq));
    return publish(buf);
}

void ctlPushIncoming(IncomingCtl ev)
{
    std::lock_guard<std::mutex> lock(g_inbox.mutex);
    if (g_inbox.queue.size() >= IncomingInbox::kCap) {
        // Drop the oldest: a flood of errors means the face will show the
        // latest reason anyway, and we must never grow unbounded.
        g_inbox.queue.pop_front();
    }
    g_inbox.queue.push_back(std::move(ev));
}

bool ctlPopIncoming(IncomingCtl& out)
{
    std::lock_guard<std::mutex> lock(g_inbox.mutex);
    if (g_inbox.queue.empty()) {
        return false;
    }
    out = std::move(g_inbox.queue.front());
    g_inbox.queue.pop_front();
    return true;
}

}  // namespace net
