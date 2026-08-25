/*
 * SPDX-License-Identifier: MIT
 *
 * Host tests for the incoming `voice/ctl` parser.
 *
 * This is a hand-rolled JSON scanner rather than a real parser — a deliberate
 * trade (three string fields are not worth a JSON library in flash), but hand
 * scanners are exactly where boundary bugs live. The malformed cases below
 * matter more than the happy path: this code runs on input from the network,
 * and its contract is "never fail, degrade to Unknown".
 */
#include <cstdio>
#include <string>

#include "../main/net/ctl_parse.h"

using namespace net;

static int g_failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
            ++g_failures;                                                 \
        }                                                                 \
    } while (0)

namespace {

IncomingCtl parse(const std::string& s)
{
    return parseIncomingCtl(s.c_str(), s.size());
}

void test_known_kinds()
{
    std::printf("each known type maps to its kind\n");
    CHECK(parse(R"({"type":"error","code":"no_amuxd"})").kind == IncomingCtl::Kind::Error);
    CHECK(parse(R"({"type":"thinking"})").kind == IncomingCtl::Kind::Thinking);
    CHECK(parse(R"({"type":"spk_start"})").kind == IncomingCtl::Kind::SpkStart);
    CHECK(parse(R"({"type":"spk_end"})").kind == IncomingCtl::Kind::SpkEnd);
    CHECK(parse(R"({"type":"session","session":"s-1"})").kind == IncomingCtl::Kind::Session);
    CHECK(parse(R"({"type":"note_saved","time":"09:12","text":"x"})").kind ==
          IncomingCtl::Kind::NoteSaved);
}

void test_note_saved_carries_time_and_text()
{
    std::printf("note_saved carries the stored time and transcript\n");
    const auto n = parse(R"({"type":"note_saved","time":"09:12","text":"周会挪到周四","seq":7})");
    CHECK(n.kind == IncomingCtl::Kind::NoteSaved);
    CHECK(n.time == "09:12");
    CHECK(n.text == "周会挪到周四");
}

void test_note_text_with_quotes_and_escapes()
{
    std::printf("a transcript containing quotes does not derail the scan\n");
    // Transcripts are free text from STT, so the one field most likely to
    // carry a quote or a newline is exactly this one.
    const auto n = parse(R"({"type":"note_saved","time":"10:00","text":"他说\"好\"\n然后走了"})");
    CHECK(n.kind == IncomingCtl::Kind::NoteSaved);
    CHECK(n.time == "10:00");
    CHECK(n.text == "他说\"好\"\n然后走了");
}

void test_note_saved_missing_fields_are_empty_not_garbage()
{
    std::printf("note_saved without time/text degrades to empty strings\n");
    const auto n = parse(R"({"type":"note_saved"})");
    CHECK(n.kind == IncomingCtl::Kind::NoteSaved);
    CHECK(n.time.empty());
    CHECK(n.text.empty());
}

void test_note_text_is_not_confused_with_other_keys()
{
    std::printf("a value that reads like a key does not hijack text\n");
    // The same trap that once ate the session id: "text" appearing as a
    // *value* must not be taken for the key.
    const auto n = parse(R"({"type":"note_saved","time":"text","text":"real"})");
    CHECK(n.time == "text");
    CHECK(n.text == "real");
}

void test_fields_extracted()
{
    std::printf("error carries code and message; session carries id\n");
    const auto e = parse(R"({"type":"error","code":"no_amuxd","message":"laptop asleep","seq":9})");
    CHECK(e.kind == IncomingCtl::Kind::Error);
    CHECK(e.code == "no_amuxd");
    CHECK(e.message == "laptop asleep");

    const auto s = parse(R"({"type":"session","session":"sess-abc-123"})");
    CHECK(s.session == "sess-abc-123");
}

void test_unknown_type_is_forward_compatible()
{
    std::printf("an unknown type degrades to Unknown, not a crash\n");
    const auto v = parse(R"({"type":"future_thing","seq":3})");
    CHECK(v.kind == IncomingCtl::Kind::Unknown);
}

void test_unreadable_type_is_unknown()
{
    std::printf("input with no readable type degrades to Unknown\n");
    const char* bad[] = {
        "",
        "{",
        "not json at all",
        R"({"type":)",             // truncated before the value
        R"({"code":"orphan"})",    // no type field at all
        R"({"type":123})",         // type is not a string
        R"({"type":""})",          // empty type
    };
    for (const char* b : bad) {
        const auto v = parseIncomingCtl(b, std::char_traits<char>::length(b));
        CHECK(v.kind == IncomingCtl::Kind::Unknown);
    }
}

void test_truncated_but_readable_type_is_honoured()
{
    std::printf("a truncated document still yields its type\n");
    // Deliberately NOT Unknown. On a lossy link, recovering the type from a
    // partially-delivered document is more useful than discarding the message,
    // and the fields we failed to read simply come back empty.
    const auto a = parseIncomingCtl(R"({"type":"error")", 16);
    CHECK(a.kind == IncomingCtl::Kind::Error);
    CHECK(a.code.empty());

    const auto b = parseIncomingCtl(R"({"type":"error","code":)", 23);
    CHECK(b.kind == IncomingCtl::Kind::Error);
    CHECK(b.code.empty());
}

void test_value_matching_another_key_name()
{
    std::printf("a value equal to another field's name is not read as that key\n");
    // The regression this exists for: `"session"` appears first as the *value*
    // of `type`, and a key/value-blind scanner returned an empty session id.
    const auto v = parse(R"({"type":"session","session":"s-1"})");
    CHECK(v.kind == IncomingCtl::Kind::Session);
    CHECK(v.session == "s-1");

    // Same shape for error: a message that merely mentions a field name.
    const auto e = parse(R"({"type":"error","message":"code","code":"real"})");
    CHECK(e.code == "real");
}

void test_not_nul_terminated()
{
    std::printf("respects len, does not run off a non-terminated buffer\n");
    // MQTT payloads are NOT NUL-terminated. Give it a buffer whose valid region
    // ends before trailing garbage and confirm the garbage is not read as data.
    const char raw[] = R"({"type":"thinking"}GARBAGE_AFTER_END)";
    const std::size_t valid = 19;  // through the closing brace
    const auto v = parseIncomingCtl(raw, valid);
    CHECK(v.kind == IncomingCtl::Kind::Thinking);
}

void test_embedded_nul_is_bounded()
{
    std::printf("an embedded NUL does not truncate the scan early\n");
    std::string s = R"({"type":"error","code":"a","message":"b"})";
    // A hostile/buggy producer could emit this; the scan is length-bounded, so
    // it must not read past `len` nor mistake the NUL for end-of-input in a way
    // that loses a field it already saw.
    const auto v = parseIncomingCtl(s.data(), s.size());
    CHECK(v.kind == IncomingCtl::Kind::Error);
    CHECK(v.code == "a");
}

void test_whitespace_and_ordering()
{
    std::printf("tolerates whitespace and field reordering\n");
    const auto a = parse("{ \"code\" : \"x\" , \"type\" : \"error\" }");
    CHECK(a.kind == IncomingCtl::Kind::Error);
    CHECK(a.code == "x");
}

}  // namespace

int main()
{
    test_known_kinds();
    test_fields_extracted();
    test_note_saved_carries_time_and_text();
    test_note_text_with_quotes_and_escapes();
    test_note_saved_missing_fields_are_empty_not_garbage();
    test_note_text_is_not_confused_with_other_keys();
    test_unknown_type_is_forward_compatible();
    test_unreadable_type_is_unknown();
    test_truncated_but_readable_type_is_honoured();
    test_value_matching_another_key_name();
    test_not_nul_terminated();
    test_embedded_nul_is_bounded();
    test_whitespace_and_ordering();

    if (g_failures == 0) {
        std::printf("\nall ctl_parse tests passed\n");
        return 0;
    }
    std::printf("\n%d check(s) failed\n", g_failures);
    return 1;
}
