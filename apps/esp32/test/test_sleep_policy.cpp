/*
 * SPDX-License-Identifier: MIT
 *
 * Host tests for the tiered sleep policy. See test/run.sh.
 */
#include <cstdio>

#include "../main/power/sleep_policy.h"

using namespace power;

static int g_failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
            ++g_failures;                                                 \
        }                                                                 \
    } while (0)

namespace {

SleepConfig cfg()
{
    SleepConfig c;
    c.dimAfterMs = 1000;
    c.screenOffAfterMs = 2000;
    c.lightSleepAfterMs = 3000;
    c.lightSleepAfterUserSleepMs = 500;
    return c;
}

void test_inactivity_ladder()
{
    std::printf("inactivity walks active -> dim -> screenoff -> lightsleep\n");
    SleepPolicy p;
    p.init(cfg(), 0);
    Inputs in;

    CHECK(p.tick(500, in) == Tier::Active);
    CHECK(p.tick(1000, in) == Tier::Dim);
    CHECK(p.tick(1999, in) == Tier::Dim);
    CHECK(p.tick(2000, in) == Tier::ScreenOff);
    CHECK(p.tick(2999, in) == Tier::ScreenOff);
    CHECK(p.tick(3000, in) == Tier::LightSleep);
}

void test_activity_resets_to_active()
{
    std::printf("activity snaps back to active from any tier\n");
    SleepPolicy p;
    p.init(cfg(), 0);
    Inputs in;

    CHECK(p.tick(3000, in) == Tier::LightSleep);
    p.noteActivity(3100);
    CHECK(p.tick(3100, in) == Tier::Active);
    CHECK(p.idleMs(3100) == 0);
}

void test_busy_never_sleeps()
{
    std::printf("busy pins active and outranks the ladder\n");
    SleepPolicy p;
    p.init(cfg(), 0);
    Inputs in;
    in.busy = true;

    // Far past every threshold, but audio is in flight.
    CHECK(p.tick(10000, in) == Tier::Active);
    CHECK(p.tick(60000, in) == Tier::Active);

    // Releasing must not drop straight to a deep tier: busy keeps the idle
    // clock fed, so the ladder restarts from the moment it ends.
    in.busy = false;
    CHECK(p.tick(60100, in) == Tier::Active);
    CHECK(p.tick(61000, in) == Tier::Dim);
}

void test_busy_outranks_user_sleep()
{
    std::printf("busy outranks an explicit power press\n");
    SleepPolicy p;
    p.init(cfg(), 0);
    Inputs in;
    in.busy = true;
    in.userAsleep = true;
    CHECK(p.tick(5000, in) == Tier::Active);
}

void test_user_sleep_goes_dark_immediately()
{
    std::printf("power press darkens at once, then light-sleeps early\n");
    SleepPolicy p;
    p.init(cfg(), 0);
    Inputs in;

    in.userAsleep = true;
    CHECK(p.tick(100, in) == Tier::ScreenOff);   // immediate, no dim step
    CHECK(p.tick(400, in) == Tier::ScreenOff);
    // Shortened ladder measured from the press, not from last activity.
    CHECK(p.tick(600, in) == Tier::LightSleep);
}

void test_user_sleep_ladder_measured_from_press()
{
    std::printf("the shortened ladder starts at the press, not at boot\n");
    SleepPolicy p;
    p.init(cfg(), 0);
    Inputs in;

    // Idle a long while first, then press power.
    CHECK(p.tick(2500, in) == Tier::ScreenOff);
    in.userAsleep = true;
    CHECK(p.tick(2600, in) == Tier::ScreenOff);       // press at 2600
    CHECK(p.tick(3000, in) == Tier::ScreenOff);       // only 400ms since press
    CHECK(p.tick(3100, in) == Tier::LightSleep);      // 500ms since press
}

void test_wake_from_user_sleep()
{
    std::printf("clearing userAsleep returns to active\n");
    SleepPolicy p;
    p.init(cfg(), 0);
    Inputs in;
    in.userAsleep = true;
    // The press is registered at this tick, so nothing has elapsed since it yet.
    CHECK(p.tick(1000, in) == Tier::ScreenOff);
    CHECK(p.tick(1600, in) == Tier::LightSleep);

    in.userAsleep = false;
    p.noteActivity(1700);
    CHECK(p.tick(1700, in) == Tier::Active);
}

void test_light_sleep_can_be_disabled()
{
    std::printf("disabling light sleep floors the ladder at screenoff\n");
    SleepPolicy p;
    SleepConfig c = cfg();
    c.enableLightSleep = false;
    p.init(c, 0);
    Inputs in;

    CHECK(p.tick(10000, in) == Tier::ScreenOff);
    in.userAsleep = true;
    CHECK(p.tick(20000, in) == Tier::ScreenOff);
}

void test_changed_edge_only()
{
    std::printf("changed() is true only on the edge\n");
    SleepPolicy p;
    p.init(cfg(), 0);
    Inputs in;

    p.tick(1000, in);
    CHECK(p.changed());   // active -> dim
    p.tick(1500, in);
    CHECK(!p.changed());  // still dim
    p.tick(2000, in);
    CHECK(p.changed());   // dim -> screenoff
}

}  // namespace

int main()
{
    test_inactivity_ladder();
    test_activity_resets_to_active();
    test_busy_never_sleeps();
    test_busy_outranks_user_sleep();
    test_user_sleep_goes_dark_immediately();
    test_user_sleep_ladder_measured_from_press();
    test_wake_from_user_sleep();
    test_light_sleep_can_be_disabled();
    test_changed_edge_only();

    if (g_failures == 0) {
        std::printf("\nall sleep_policy tests passed\n");
        return 0;
    }
    std::printf("\n%d check(s) failed\n", g_failures);
    return 1;
}
