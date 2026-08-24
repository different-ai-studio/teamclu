/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include "utils/wear_levelling/wear_levelling.h"
#include <mooncake_log.h>

static const std::string_view _tag = "HAL-FS";

void Hal::fs_init()
{
    mclog::tagInfo(_tag, "init");

    wear_levelling_init();
}
