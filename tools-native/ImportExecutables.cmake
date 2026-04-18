# Hand-written import file for cross-compile builds that cannot build the
# native helper tools themselves (Emscripten on a host without a native C
# toolchain for the UZDoom helpers).
#
# Produces imported targets equivalent to the ones add_executable(...)
# would create on a normal native build: re2c, lemon, zipdir.
# zipdir is a placeholder — when unavailable, the top-level CMakeLists
# falls back to tools/zipdir/zipdir.py.

if(NOT TARGET re2c)
    add_executable(re2c IMPORTED)
    set_target_properties(re2c PROPERTIES
        IMPORTED_LOCATION "${CMAKE_CURRENT_LIST_DIR}/re2c/re2c.exe")
endif()

if(NOT TARGET lemon)
    add_executable(lemon IMPORTED)
    set_target_properties(lemon PROPERTIES
        IMPORTED_LOCATION "${CMAKE_CURRENT_LIST_DIR}/lemon/lemon.exe")
endif()
