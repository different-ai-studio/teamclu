/*
 * SPDX-FileCopyrightText: 2025 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "ctl_parse.h"

#include <cstring>

namespace net {
namespace {

// Extract the string value of a flat JSON field `"key":"value"`. Returns an
// empty string if the key is absent or the value is not a string. Handles the
// common escapes (\" \\ \n \t \r \uXXXX) so a message with a quote in it does
// not confuse the scanner. Numbers / booleans are ignored — none of the
// fields we act on are non-strings.
std::string extractString(const char* json, std::size_t len, const char* key)
{
    // Build the search needle `"key"`.
    char needle[24];
    const std::size_t keyLen = std::strlen(key);
    if (keyLen == 0 || keyLen + 3 > sizeof(needle)) {
        return {};
    }
    needle[0] = '"';
    std::memcpy(needle + 1, key, keyLen);
    needle[1 + keyLen] = '"';
    needle[2 + keyLen] = '\0';
    const std::size_t needleLen = 2 + keyLen;

    // Find the needle IN KEY POSITION.
    //
    // Matching the bare token is not enough: in `{"type":"session","session":
    // "s-1"}` the first `"session"` is the *value* of `type`, and treating it
    // as the key made the scan expect a ':' where a ',' sits — so the real
    // session id was silently dropped. A key in a flat document is always
    // preceded by '{' or ',' (modulo whitespace), so require that.
    if (len < needleLen) {
        return {};
    }
    std::size_t i = 0;
    bool found = false;
    for (; i + needleLen <= len; ++i) {
        if (std::memcmp(json + i, needle, needleLen) != 0) {
            continue;
        }
        std::size_t j = i;
        while (j > 0) {
            const char p = json[j - 1];
            if (p == ' ' || p == '\t' || p == '\n' || p == '\r') {
                --j;
                continue;
            }
            break;
        }
        if (j == 0 || json[j - 1] == '{' || json[j - 1] == ',') {
            found = true;
            break;
        }
    }
    if (!found) {
        return {};  // key not found in key position
    }
    i += needleLen;

    // Skip whitespace, expect ':', skip whitespace, expect opening '"'.
    auto skipWs = [&] {
        while (i < len) {
            char c = json[i];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                ++i;
            } else {
                break;
            }
        }
    };
    skipWs();
    if (i >= len || json[i] != ':') {
        return {};
    }
    ++i;
    skipWs();
    if (i >= len || json[i] != '"') {
        return {};  // not a string value (number/bool/null) — ignore
    }
    ++i;  // consume opening quote

    std::string out;
    for (; i < len; ++i) {
        char c = json[i];
        if (c == '"') {
            return out;  // closing quote
        }
        if (c != '\\') {
            out.push_back(c);
            continue;
        }
        // escape
        ++i;
        if (i >= len) {
            break;
        }
        switch (json[i]) {
            case '"':  out.push_back('"');  break;
            case '\\': out.push_back('\\'); break;
            case '/':  out.push_back('/');  break;
            case 'n':  out.push_back('\n'); break;
            case 't':  out.push_back('\t'); break;
            case 'r':  out.push_back('\r'); break;
            case 'b':  out.push_back('\b'); break;
            case 'f':  out.push_back('\f'); break;
            case 'u': {
                // \uXXXX — keep as the literal for now; we don't render
                // device error messages as glyphs from ctl, only log them.
                if (i + 4 < len) {
                    out.append(json + i - 1, 6);  // keep "\uXXXX"
                    i += 4;
                }
                break;
            }
            default:
                out.push_back(json[i]);
                break;
        }
    }
    return out;  // unterminated — return what we have
}

IncomingCtl::Kind kindFromType(const std::string& type)
{
    if (type == "error")      return IncomingCtl::Kind::Error;
    if (type == "thinking")   return IncomingCtl::Kind::Thinking;
    if (type == "spk_start")  return IncomingCtl::Kind::SpkStart;
    if (type == "spk_end")    return IncomingCtl::Kind::SpkEnd;
    if (type == "session")    return IncomingCtl::Kind::Session;
    if (type == "note_saved") return IncomingCtl::Kind::NoteSaved;
    return IncomingCtl::Kind::Unknown;
}

}  // namespace

IncomingCtl parseIncomingCtl(const char* json, std::size_t len)
{
    IncomingCtl out;
    if (json == nullptr || len == 0) {
        return out;
    }
    const std::string type = extractString(json, len, "type");
    out.kind = kindFromType(type);
    switch (out.kind) {
        case IncomingCtl::Kind::Error:
            out.code = extractString(json, len, "code");
            out.message = extractString(json, len, "message");
            break;
        case IncomingCtl::Kind::Session:
            out.session = extractString(json, len, "session");
            break;
        case IncomingCtl::Kind::NoteSaved:
            out.time = extractString(json, len, "time");
            out.text = extractString(json, len, "text");
            break;
        case IncomingCtl::Kind::Thinking:
        case IncomingCtl::Kind::SpkStart:
        case IncomingCtl::Kind::SpkEnd:
        case IncomingCtl::Kind::Unknown:
            break;
    }
    return out;
}

}  // namespace net
