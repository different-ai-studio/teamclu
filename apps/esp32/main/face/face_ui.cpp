/*
 * SPDX-License-Identifier: MIT
 */
#include "face_ui.h"

#include <array>

#include "palette.h"

/* ---------------------------------- Fonts ---------------------------------- */
// Font declarations MUST sit at global scope with C linkage. The font tables
// are compiled as C, so their symbols are unmangled; declaring them inside the
// anonymous namespace below instead gives them internal C++ linkage, which
// fails at *link* time with an undefined reference rather than at compile time.
//
// The clock is Latin/numeric and uses a large face copied from the M5Stack
// demo. Everything else is Chinese and needs a subset font built by
// tools/gen_fonts.sh — until that runs, CJK labels fall back to Montserrat and
// render as boxes. See README "Fonts".
#if __has_include("assets/fonts/face_font_cjk.h")
#include "assets/fonts/face_font_cjk.h"  // declares its own C linkage
#define FACE_CJK_18 (&face_font_cjk_18)
#define FACE_CJK_22 (&face_font_cjk_22)
#else
#define FACE_CJK_18 (&lv_font_montserrat_18)
#define FACE_CJK_22 (&lv_font_montserrat_22)
#endif

extern "C" {
LV_FONT_DECLARE(CommissionerMedium108);
}

#define FACE_CLOCK_FONT (&CommissionerMedium108)
#define FACE_MONO_36 (&lv_font_montserrat_36)

namespace face {
namespace {

// Idle chatter, from the design canvas's QUIPS array.
constexpr std::array<const char*, 4> kQuips = {"在等你说话", "闲着", "耳朵开着", "随时听候"};
constexpr std::uint32_t kQuipRotateMs = 6000;

inline lv_color_t C(std::uint32_t rgb)
{
    return lv_color_hex(rgb);
}

// A plain filled rectangle. The design system's --radius-* are all 0px, so the
// face is strictly rectilinear; that is deliberate and not a shortcut.
lv_obj_t* mkBox(lv_obj_t* parent, int w, int h, std::uint32_t color)
{
    lv_obj_t* o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_bg_color(o, C(color), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(o, 0, 0);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    return o;
}

// Transparent flex container. Used for the eye pair and the dot/bar rows.
lv_obj_t* mkRow(lv_obj_t* parent, int gap, lv_flex_align_t cross = LV_FLEX_ALIGN_CENTER)
{
    lv_obj_t* o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_size(o, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(o, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(o, LV_FLEX_ALIGN_CENTER, cross, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(o, gap, 0);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    return o;
}

// Vertical stack, centered on the round screen. Every scene is one of these.
lv_obj_t* mkColumn(lv_obj_t* parent, int gap)
{
    lv_obj_t* o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_size(o, ScreenW, ScreenH);
    lv_obj_set_flex_flow(o, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(o, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(o, gap, 0);
    lv_obj_center(o);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    return o;
}

lv_obj_t* mkLabel(lv_obj_t* parent, const char* text, const lv_font_t* font, std::uint32_t color)
{
    lv_obj_t* l = lv_label_create(parent);
    lv_label_set_text(l, text);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, C(color), 0);
    return l;
}

/* -------------------------------- Animation -------------------------------- */
// Translate rather than position: the scenes are flex-laid-out, and animating
// x/y would fight the layout engine every frame.
void execTranslateY(void* o, std::int32_t v)
{
    lv_obj_set_style_translate_y(static_cast<lv_obj_t*>(o), v, 0);
}
void execTranslateX(void* o, std::int32_t v)
{
    lv_obj_set_style_translate_x(static_cast<lv_obj_t*>(o), v, 0);
}
void execHeight(void* o, std::int32_t v)
{
    lv_obj_set_height(static_cast<lv_obj_t*>(o), v);
}
void execWidth(void* o, std::int32_t v)
{
    lv_obj_set_width(static_cast<lv_obj_t*>(o), v);
}

// Ping-pong forever: the CSS `alternate infinite` idiom the canvas uses.
void loopAnim(lv_obj_t* target, lv_anim_exec_xcb_t cb, std::int32_t from, std::int32_t to,
              std::uint32_t durationMs, std::uint32_t delayMs = 0)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, target);
    lv_anim_set_exec_cb(&a, cb);
    lv_anim_set_values(&a, from, to);
    lv_anim_set_duration(&a, durationMs / 2);
    lv_anim_set_reverse_duration(&a, durationMs / 2);  // 9.5 name; was set_playback_duration
    lv_anim_set_delay(&a, delayMs);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
    lv_anim_start(&a);
}

// One-shot, used for the `pop` on the Saved screen.
void onceAnim(lv_obj_t* target, lv_anim_exec_xcb_t cb, std::int32_t from, std::int32_t to,
              std::uint32_t durationMs)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, target);
    lv_anim_set_exec_cb(&a, cb);
    lv_anim_set_values(&a, from, to);
    lv_anim_set_duration(&a, durationMs);
    lv_anim_set_path_cb(&a, lv_anim_path_overshoot);
    lv_anim_start(&a);
}

// A blink is a rare, fast squash — not a duty cycle. Encoding it as a looping
// anim would need a 96%-flat easing curve; a timer that fires a short squash is
// both simpler and closer to what the canvas actually does.
struct BlinkCtx {
    lv_obj_t* eye;
    std::int32_t openH;
};

void blinkTimerCb(lv_timer_t* t)
{
    auto* ctx = static_cast<BlinkCtx*>(lv_timer_get_user_data(t));
    if (ctx == nullptr || ctx->eye == nullptr) {
        return;
    }
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, ctx->eye);
    lv_anim_set_exec_cb(&a, execHeight);
    lv_anim_set_values(&a, ctx->openH, ctx->openH / 12 + 1);
    lv_anim_set_duration(&a, 60);
    lv_anim_set_reverse_duration(&a, 60);
    lv_anim_start(&a);
}

// Attaches a self-freeing blink timer to an eye. The context is owned by the
// timer and released when the object dies, so scene teardown cannot leak it.
void attachBlink(lv_obj_t* eye, std::int32_t openH, std::uint32_t periodMs, std::uint32_t phaseMs)
{
    auto* ctx = new BlinkCtx{eye, openH};
    lv_timer_t* t = lv_timer_create(blinkTimerCb, periodMs, ctx);
    lv_timer_set_repeat_count(t, -1);
    if (phaseMs != 0) {
        lv_timer_set_period(t, periodMs);
        lv_timer_reset(t);
    }
    lv_obj_add_event_cb(
        eye,
        [](lv_event_t* e) {
            auto* timer = static_cast<lv_timer_t*>(lv_event_get_user_data(e));
            auto* c = static_cast<BlinkCtx*>(lv_timer_get_user_data(timer));
            lv_timer_delete(timer);
            delete c;
        },
        LV_EVENT_DELETE, t);
}

}  // namespace

/* ---------------------------------- Public --------------------------------- */

void FaceUi::init(lv_obj_t* parent)
{
    _root = lv_obj_create(parent);
    lv_obj_remove_style_all(_root);
    lv_obj_set_size(_root, ScreenW, ScreenH);
    lv_obj_center(_root);
    lv_obj_set_style_bg_color(_root, C(ColorBg), 0);
    lv_obj_set_style_bg_opa(_root, LV_OPA_COVER, 0);
    lv_obj_remove_flag(_root, LV_OBJ_FLAG_SCROLLABLE);
    _built = false;
}

void FaceUi::setClock(std::string hhmm)
{
    _clock = std::move(hhmm);
}

void FaceUi::render(const FaceState& st, std::uint32_t nowMs)
{
    if (_root == nullptr) {
        return;
    }

    // Rebuild when anything structural changed. Mode and error kind matter
    // because they change colors and copy, not just layout; note count matters
    // because the Saved and Notes screens print it.
    const bool structural = !_built || st.screen() != _builtScreen || st.mode() != _builtMode ||
                            st.error() != _builtError ||
                            ((st.screen() == Screen::Notes || st.screen() == Screen::Saved) &&
                             st.noteCount() != _builtNoteCount);
    if (structural) {
        rebuild(st);
    }
    refreshDynamic(st, nowMs);
}

void FaceUi::rebuild(const FaceState& st)
{
    lv_obj_clean(_root);  // deletes children, their anims, and their blink timers
    _clockLabel = _quipLabel = _eyeL = _eyeR = _battFill = nullptr;
    _blinkTimer = nullptr;

    switch (st.screen()) {
        case Screen::Idle:   buildIdle(st);   break;
        case Screen::Listen: buildListen(st); break;
        case Screen::Think:  buildThink(st);  break;
        case Screen::Reply:  buildReply(st);  break;
        case Screen::Saving: buildSaving(st); break;
        case Screen::Saved:  buildSaved(st);  break;
        case Screen::Notes:  buildNotes(st);  break;
        case Screen::Wifi:   buildWifi(st);   break;
        case Screen::Sleep:  buildSleep(st);  break;
        case Screen::Error:  buildError(st);  break;
    }

    _built = true;
    _builtScreen = st.screen();
    _builtMode = st.mode();
    _builtError = st.error();
    _builtNoteCount = st.noteCount();
}

void FaceUi::refreshDynamic(const FaceState& st, std::uint32_t nowMs)
{
    if (_clockLabel != nullptr) {
        lv_label_set_text(_clockLabel, _clock.c_str());
    }
    if (_quipLabel != nullptr && (nowMs - _quipAt) >= kQuipRotateMs) {
        _quipAt = nowMs;
        _quipIndex = (_quipIndex + 1) % static_cast<int>(kQuips.size());
        lv_label_set_text(_quipLabel, kQuips[_quipIndex]);
    }

    // Battery is refreshed in place rather than by rebuilding: it changes in 1%
    // steps that are minutes apart, and tearing down the scene for that would
    // restart every blink and sway animation mid-stride.
    if (_battFill != nullptr) {
        const int pct = st.batteryPct();
        int w = BattBarW * pct / 100;
        if (pct > 0 && w < 2) {
            w = 2;  // never render "some charge" as an empty bar
        }
        lv_obj_set_width(_battFill, w);

        std::uint32_t fill = ColorMid;
        if (st.batteryCharging()) {
            fill = ColorFg;  // white reads as "not on battery"
        } else if (pct <= BattLowPct) {
            fill = ColorAccent;  // accent is this palette's "notice me"
        }
        lv_obj_set_style_bg_color(_battFill, C(fill), 0);
    }
}

/* ---------------------------------- Scenes --------------------------------- */

void FaceUi::buildIdle(const FaceState&)
{
    // Battery. Absolutely placed against the top of the circle rather than
    // added to the column below, so the canvas's deliberate three-element
    // composition (eyes / clock / quip) keeps its spacing and balance.
    lv_obj_t* track = mkBox(_root, BattBarW, BattBarH, ColorSleep);
    lv_obj_align(track, LV_ALIGN_TOP_MID, 0, BattBarTopY);
    _battFill = mkBox(track, 0, BattBarH, ColorMid);
    lv_obj_align(_battFill, LV_ALIGN_LEFT_MID, 0, 0);

    lv_obj_t* col = mkColumn(_root, 34);
    lv_obj_t* eyes = mkRow(col, EyeGap);
    _eyeL = mkBox(eyes, EyeIdleW, EyeIdleH, ColorAccent);
    _eyeR = mkBox(eyes, EyeIdleW, EyeIdleH, ColorAccent);
    attachBlink(_eyeL, EyeIdleH, AnimBlinkMs, 0);
    attachBlink(_eyeR, EyeIdleH, AnimBlink2Ms, 400);
    // The pair sways as a unit — the eyes never move relative to each other.
    loopAnim(eyes, execTranslateX, -LeanAmplitudePx, LeanAmplitudePx, AnimLeanMs);

    _clockLabel = mkLabel(col, _clock.c_str(), FACE_CLOCK_FONT, ColorFg);
    _quipLabel = mkLabel(col, kQuips[_quipIndex], FACE_CJK_18, ColorDim);
}

void FaceUi::buildListen(const FaceState& st)
{
    // Chat listens in accent; note listens in white. That single color swap is
    // the only thing telling the user which button they are holding.
    const std::uint32_t wave = (st.mode() == Mode::Chat) ? ColorAccent : ColorFg;

    lv_obj_t* col = mkColumn(_root, 44);
    lv_obj_t* eyes = mkRow(col, EyeGap);
    _eyeL = mkBox(eyes, EyeListenW, EyeListenH, wave);
    _eyeR = mkBox(eyes, EyeListenW, EyeListenH, wave);

    lv_obj_t* bars = mkRow(col, WaveBarGap);
    lv_obj_set_height(bars, WaveBarH);
    for (int i = 0; i < WaveBars; ++i) {
        lv_obj_t* b = mkBox(bars, WaveBarW, WaveBarH, wave);
        loopAnim(b, execHeight, WaveBarH * 14 / 100, WaveBarH, AnimWaveMs,
                 static_cast<std::uint32_t>(i) * AnimWaveStaggerMs);
    }

    mkLabel(col, st.mode() == Mode::Chat ? "听着呢" : "记着呢", FACE_CJK_18, ColorDim);
}

void FaceUi::buildThink(const FaceState&)
{
    lv_obj_t* col = mkColumn(_root, 46);
    lv_obj_t* eyes = mkRow(col, EyeGap);
    _eyeL = mkBox(eyes, EyeSquareW, EyeSquareH, ColorAccent);
    _eyeR = mkBox(eyes, EyeSquareW, EyeSquareH, ColorAccent);
    loopAnim(eyes, execTranslateY, 0, -BobAmplitudePx, AnimBobMs);

    lv_obj_t* dots = mkRow(col, ThinkDotGap);
    for (int i = 0; i < ThinkDots; ++i) {
        lv_obj_t* d = mkBox(dots, ThinkDotSize, ThinkDotSize, ColorDim);
        loopAnim(d, execTranslateY, 0, DriftAmplitudePx, AnimDriftMs,
                 static_cast<std::uint32_t>(i) * 150);
    }
}

void FaceUi::buildReply(const FaceState&)
{
    lv_obj_t* col = mkColumn(_root, 52);
    lv_obj_t* eyes = mkRow(col, EyeGap);
    _eyeL = mkBox(eyes, EyeSquareW, EyeSquareH, ColorAccent);
    _eyeR = mkBox(eyes, EyeSquareW, EyeSquareH, ColorAccent);
    attachBlink(_eyeL, EyeSquareH, 4000, 0);
    attachBlink(_eyeR, EyeSquareH, 4000, 350);

    // The mouth is the entire "it is talking" signal — no text, by design.
    lv_obj_t* mouth = mkBox(col, MouthW, MouthH, ColorAccent);
    loopAnim(mouth, execWidth, MouthW, MouthW * 45 / 100, AnimChewMs);
}

void FaceUi::buildSaving(const FaceState&)
{
    lv_obj_t* col = mkColumn(_root, 40);
    lv_obj_t* eyes = mkRow(col, EyeGap);
    _eyeL = mkBox(eyes, EyeSquareW, EyeSquareH, ColorFg);
    _eyeR = mkBox(eyes, EyeSquareW, EyeSquareH, ColorFg);
    attachBlink(_eyeL, EyeSquareH, 1400, 0);
    attachBlink(_eyeR, EyeSquareH, 1400, 200);

    lv_obj_t* dots = mkRow(col, SavingDotGap);
    for (int i = 0; i < SavingDots; ++i) {
        lv_obj_t* d = mkBox(dots, SavingDotSize, SavingDotSize, ColorAccent);
        loopAnim(d, execTranslateY, 0, DriftAmplitudePx, AnimDriftSaveMs,
                 static_cast<std::uint32_t>(i) * 200);
    }
}

void FaceUi::buildSaved(const FaceState& st)
{
    lv_obj_t* col = mkColumn(_root, 36);

    // Smiling eyes: two bars tilted in mirror. LVGL rotates around the object
    // centre, which is what the canvas's rotate() does too.
    lv_obj_t* eyes = mkRow(col, EyeGapSaved);
    _eyeL = mkBox(eyes, EyeSavedW, EyeSavedH, ColorAccent);
    _eyeR = mkBox(eyes, EyeSavedW, EyeSavedH, ColorAccent);
    lv_obj_set_style_transform_rotation(_eyeL, -EyeSavedTiltDeg * 10, 0);  // LVGL: 0.1° units
    lv_obj_set_style_transform_rotation(_eyeR, EyeSavedTiltDeg * 10, 0);

    lv_obj_t* block = mkBox(col, SavedBlockSize, SavedBlockSize, ColorAccent);
    onceAnim(block, execWidth, SavedBlockSize * 40 / 100, SavedBlockSize, AnimPopMs);

    char buf[48];
    lv_snprintf(buf, sizeof(buf), "收好了 · %d", static_cast<int>(st.noteCount()));
    mkLabel(col, buf, FACE_CJK_18, ColorMuted);
}

void FaceUi::buildNotes(const FaceState& st)
{
    // The one screen that shows text. The canvas insets it 108/62/96 so the
    // list clears the round bezel; keep those numbers.
    lv_obj_t* list = lv_obj_create(_root);
    lv_obj_remove_style_all(list);
    lv_obj_set_size(list, ScreenW - 62 * 2, ScreenH - 108 - 96);
    lv_obj_align(list, LV_ALIGN_CENTER, 0, (108 - 96) / 2);
    lv_obj_set_flex_flow(list, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(list, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
    lv_obj_remove_flag(list, LV_OBJ_FLAG_SCROLLABLE);

    const auto recent = st.recentNotes(3);
    if (recent.empty()) {
        mkLabel(list, "今天还没记东西", FACE_CJK_22, ColorDim);
        return;
    }

    for (const auto& n : recent) {
        lv_obj_t* row = lv_obj_create(list);
        lv_obj_remove_style_all(row);
        lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
        lv_obj_set_style_pad_ver(row, 16, 0);
        lv_obj_set_style_border_side(row, LV_BORDER_SIDE_BOTTOM, 0);
        lv_obj_set_style_border_width(row, 2, 0);
        lv_obj_set_style_border_color(row, C(ColorSleep), 0);
        lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
        lv_obj_set_style_pad_column(row, 16, 0);
        lv_obj_remove_flag(row, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t* t = mkLabel(row, n.time.c_str(), FACE_CJK_18, ColorMid);
        lv_obj_set_width(t, 50);

        lv_obj_t* txt = mkLabel(row, n.text.c_str(), FACE_CJK_22, ColorFg);
        lv_obj_set_flex_grow(txt, 1);
        lv_label_set_long_mode(txt, LV_LABEL_LONG_WRAP);
    }
}

void FaceUi::buildWifi(const FaceState& st)
{
    lv_obj_t* col = mkColumn(_root, 30);
    lv_obj_t* eyes = mkRow(col, EyeGap);
    _eyeL = mkBox(eyes, EyeSquareW, EyeSquareH, ColorDim);
    _eyeR = mkBox(eyes, EyeSquareW, EyeSquareH, ColorDim);
    loopAnim(_eyeL, execTranslateY, 0, DriftAmplitudePx, AnimDriftWifiMs);
    loopAnim(_eyeR, execTranslateY, 0, DriftAmplitudePx, AnimDriftWifiMs, 300);

    mkLabel(col, st.deviceCode().empty() ? "----" : st.deviceCode().c_str(), FACE_MONO_36,
            ColorFg);
    mkLabel(col, "还没连上 · 开 192.168.4.1", FACE_CJK_18, ColorMid);
}

void FaceUi::buildSleep(const FaceState&)
{
    lv_obj_t* eyes = mkRow(_root, EyeGapSleep);
    lv_obj_center(eyes);
    _eyeL = mkBox(eyes, EyeSleepW, EyeSleepH, ColorSleep);
    _eyeR = mkBox(eyes, EyeSleepW, EyeSleepH, ColorSleep);
}

void FaceUi::buildError(const FaceState& st)
{
    // The design has no error screen; this follows its vocabulary rather than
    // inventing a new one — same two eyes, dimmed, plus the one line the user
    // needs to know which failure it is (plan rev2 §4).
    const char* why = "出错了";
    switch (st.error()) {
        case ErrorKind::NoWifi:   why = "没连上 Wi-Fi"; break;
        case ErrorKind::NoBroker: why = "连不上服务器"; break;
        case ErrorKind::NoAgent:  why = "电脑没醒着"; break;
        case ErrorKind::Upstream: why = "它那边出错了"; break;
        case ErrorKind::None:     break;
    }

    lv_obj_t* col = mkColumn(_root, 34);
    lv_obj_t* eyes = mkRow(col, EyeGap);
    // Eyes as crossed-out bars: same slant vocabulary as Saved, inverted mood.
    _eyeL = mkBox(eyes, EyeSavedW, EyeSavedH, ColorMid);
    _eyeR = mkBox(eyes, EyeSavedW, EyeSavedH, ColorMid);
    lv_obj_set_style_transform_rotation(_eyeL, EyeSavedTiltDeg * 10, 0);
    lv_obj_set_style_transform_rotation(_eyeR, -EyeSavedTiltDeg * 10, 0);

    mkLabel(col, why, FACE_CJK_22, ColorFg);
    mkLabel(col, "按任意键", FACE_CJK_18, ColorDim);
}

}  // namespace face
