cmake_minimum_required(VERSION 3.16)
project(libvpx-stub C)

add_library(vpx-stub STATIC src/vpx_stub.c)
target_include_directories(vpx-stub PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
