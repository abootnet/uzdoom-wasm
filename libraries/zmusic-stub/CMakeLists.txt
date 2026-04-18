cmake_minimum_required(VERSION 3.16)
project(zmusic-stub C CXX)

# stb_vorbis.c, tsf.h, and tml.h are all single-header C99 libraries that
# use idioms which don't translate cleanly to C++. Compile each as C.
add_library(zmusic STATIC
    src/zmusic_stub.cpp
    src/stb_vorbis_impl.c
    src/tsf_impl.c
)
target_include_directories(zmusic PUBLIC include)
target_include_directories(zmusic PRIVATE src)
target_compile_features(zmusic PUBLIC cxx_std_17)

# Vendored single-header libraries have historic warnings (unused vars/funcs,
# tautological compares, etc.) we don't want to fix in-tree; downgrade so
# the build stays quiet.
set_source_files_properties(src/stb_vorbis_impl.c PROPERTIES
    COMPILE_FLAGS "-Wno-unused-function -Wno-unused-variable -Wno-unused-but-set-variable -Wno-sign-compare"
)
set_source_files_properties(src/tsf_impl.c PROPERTIES
    COMPILE_FLAGS "-Wno-unused-function -Wno-unused-variable -Wno-unused-but-set-variable -Wno-sign-compare -Wno-missing-field-initializers"
)
