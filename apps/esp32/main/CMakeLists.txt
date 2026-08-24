file(GLOB_RECURSE MY_SRCS
    "apps/*.c"
    "apps/*.cc"
    "apps/*.cpp"
    "assets/*.c"
    "assets/*.cc"
    "assets/*.cpp"
    "face/*.c"
    "face/*.cc"
    "face/*.cpp"
    "net/*.c"
    "net/*.cpp"
    "power/*.c"
    "power/*.cpp"
    "hal/*.c"
    "hal/*.cc"
    "hal/*.cpp"
)

set(MY_INCS
    "."
)

idf_component_register(
    SRCS
        "main.cpp"
        ${MY_SRCS}
    INCLUDE_DIRS
        ${MY_INCS}
    EMBED_FILES
        "assets/sfx/boot_sfx.bin"
)
