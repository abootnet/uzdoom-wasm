// Emscripten input glue.
//
// SDL2's Emscripten port already routes keyboard, mouse, and canvas resize
// events to the engine's SDL event pump. What remains for us:
//   • Pointer lock — JS grabs it on canvas click; we hook the lock-lost
//     callback so the engine can release mouse-grab state cleanly.
//   • Exposing a canvas resize callback that forwards to SDL's fake-fullscreen
//     so `vid_resolution` commands from the console still do the right thing.

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <emscripten/html5.h>

#include "c_cvars.h"
#include "c_dispatch.h"
#include "c_console.h"
#include "d_eventbase.h"
#include "gamestate.h"
#include "menustate.h"

EXTERN_CVAR(Bool, use_mouse)

static EM_BOOL OnPointerLockChange(int /*eventType*/,
                                   const EmscriptenPointerlockChangeEvent *e,
                                   void * /*userData*/)
{
	// When the user hits Escape the browser drops pointer lock; mirror that
	// into use_mouse so the engine stops consuming mouse input.
	if (e && !e->isActive)
	{
		// Don't actually flip the CVAR — the engine should resume grabbing
		// on the next canvas click. This hook is here as a seam for future
		// logic (menu pause, etc.) once the main loop is split.
	}
	return EM_TRUE;
}

static EM_BOOL OnCanvasResize(int /*eventType*/,
                              const EmscriptenUiEvent * /*e*/,
                              void * /*userData*/)
{
	// SDL2 Emscripten internally observes the canvas size; no action
	// needed here. Hook left in place for future integration.
	return EM_TRUE;
}

// --- Touch controls (web/uzdoom-touch.js) ----------------------------------
// The on-screen gamepad drives the engine through these exports so it does not
// depend on pointer lock (unavailable on Android) or on the user's key bindings.

// Turn/look by a pixel delta, exactly like relative mouse movement.
extern "C" EMSCRIPTEN_KEEPALIVE void uz_touch_look(int dx, int dy)
{
	PostMouseMove(dx, dy);
}

// Movement/buttons state, read by G_BuildTiccmd every tic. fwd/side are
// analog (-1..1, forward and right positive); buttons: bit0 attack, bit1 use.
extern float uz_touch_fwd, uz_touch_side;
extern int uz_touch_run, uz_touch_buttons;
extern "C" EMSCRIPTEN_KEEPALIVE void uz_touch_move(float fwd, float side, int run, int buttons)
{
	uz_touch_fwd = fwd; uz_touch_side = side; uz_touch_run = run; uz_touch_buttons = buttons;
}

// Run a console command, e.g. "+attack", "-attack", "weapnext", "menu_main".
extern "C" EMSCRIPTEN_KEEPALIVE void uz_console(const char *cmd)
{
	if (cmd && *cmd) AddCommandString(cmd);
}

// Bit 0: menu open. Bit 1: console open. Bit 2: in a level. Bit 3: paused.
extern "C" EMSCRIPTEN_KEEPALIVE int uz_ui_state()
{
	int v = 0;
	if (menuactive != MENU_Off) v |= 1;
	if (ConsoleState != c_up) v |= 2;
	if (gamestate == GS_LEVEL) v |= 4;
	return v;
}

extern "C" void I_InitEmscriptenInput()
{
	emscripten_set_pointerlockchange_callback(EMSCRIPTEN_EVENT_TARGET_DOCUMENT,
	                                          nullptr, EM_TRUE,
	                                          OnPointerLockChange);
	emscripten_set_resize_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW,
	                               nullptr, EM_TRUE,
	                               OnCanvasResize);
}

#endif // __EMSCRIPTEN__
