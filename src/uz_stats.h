#pragma once
// WADDICTION player stats: tell the web launcher about notable events so it
// can keep lifetime totals. No-op outside the WASM build.
//
//   code 1 = monster killed by the local player
//   code 2 = local player died
//   code 3 = local player fragged another player
//   code 4 = level completed (a = items found, b = secrets found)
//
// The page defines globalThis.UZStats.event(code, a, b); if it is missing the
// call does nothing.
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
inline void UzStat(int code, int a = 0, int b = 0)
{
	EM_ASM({ if (globalThis.UZStats && globalThis.UZStats.event) globalThis.UZStats.event($0, $1, $2); }, code, a, b);
}
#else
inline void UzStat(int, int = 0, int = 0) {}
#endif
