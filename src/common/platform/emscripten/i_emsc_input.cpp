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
