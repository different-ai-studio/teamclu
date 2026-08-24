/*
 * SPDX-License-Identifier: MIT
 *
 * LVGL rendering for the face.
 *
 * One scene is built per screen and torn down on transition. Transitions are
 * human-paced (a button press at most a few times a second), so rebuilding is
 * cheap and buys us the thing that matters: no stale animations pointing at
 * objects from the previous screen, which is the classic way these state-driven
 * UIs rot.
 *
 * Everything here must be called with the LVGL lock held (see LvglLockGuard).
 */
#pragma once
#include <lvgl.h>

#include <cstdint>
#include <string>

#include "face_state.h"

namespace face {

class FaceUi {
public:
    // `parent` is normally lv_screen_active().
    void init(lv_obj_t* parent);

    // Rebuilds on screen change, otherwise just refreshes live text (clock,
    // quip). Call once per frame under the LVGL lock.
    void render(const FaceState& st, std::uint32_t nowMs);

    // Idle screen clock, "HH:MM". Host supplies it from the RTC.
    void setClock(std::string hhmm);

private:
    void rebuild(const FaceState& st);
    void refreshDynamic(const FaceState& st, std::uint32_t nowMs);

    void buildIdle(const FaceState& st);
    void buildListen(const FaceState& st);
    void buildThink(const FaceState& st);
    void buildReply(const FaceState& st);
    void buildSaving(const FaceState& st);
    void buildSaved(const FaceState& st);
    void buildNotes(const FaceState& st);
    void buildWifi(const FaceState& st);
    void buildSleep(const FaceState& st);
    void buildError(const FaceState& st);

    lv_obj_t* _root = nullptr;

    // Live handles into the *current* scene only. Cleared on every rebuild;
    // never dereference without checking.
    lv_obj_t* _clockLabel = nullptr;
    lv_obj_t* _quipLabel = nullptr;
    lv_obj_t* _battFill = nullptr;
    lv_obj_t* _eyeL = nullptr;
    lv_obj_t* _eyeR = nullptr;
    lv_timer_t* _blinkTimer = nullptr;

    bool _built = false;
    Screen _builtScreen = Screen::Idle;
    Mode _builtMode = Mode::Chat;
    ErrorKind _builtError = ErrorKind::None;
    std::size_t _builtNoteCount = 0;

    std::string _clock = "--:--";
    std::uint32_t _quipAt = 0;
    int _quipIndex = 0;
};

}  // namespace face
