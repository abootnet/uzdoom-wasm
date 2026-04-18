// Emscripten filesystem glue.
//
// The JS loader (web/uzdoom-loader.js) mounts IDBFS at /home/web_user/.config
// and /wads before calling main(), and also pulls any prior state with
// FS.syncfs(true) — so main() sees a warm, populated VFS.
//
// All this module adds is:
//   • I_InitEmscriptenFS()  — called from main() to ensure mount directories
//                              exist on disk and syncfs has landed. Safe no-op
//                              if the JS side already did the work.
//   • uzdoom_sync_saves()   — EMSCRIPTEN_KEEPALIVE entry JS can call after
//                              a save to flush IDBFS to IndexedDB immediately.

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <sys/stat.h>
#include <errno.h>

extern "C" void I_InitEmscriptenFS()
{
	// Make sure the user-writable tree exists in MEMFS, even on the very
	// first run before IDBFS has anything to restore. mkdir is idempotent.
	mkdir("/home",                           0755);
	mkdir("/home/web_user",                  0755);
	mkdir("/home/web_user/.config",          0755);
	mkdir("/home/web_user/.config/uzdoom",   0755);
	mkdir("/home/web_user/.config/uzdoom/savegames", 0755);
	mkdir("/home/web_user/.config/uzdoom/cache",     0755);
	mkdir("/home/web_user/.config/uzdoom/screenshots", 0755);
}

extern "C" EMSCRIPTEN_KEEPALIVE void uzdoom_sync_saves()
{
	EM_ASM({
		if (typeof FS !== 'undefined') {
			FS.syncfs(false, function (err) {
				if (err) console.warn('uzdoom_sync_saves:', err);
			});
		}
	});
}

#endif // __EMSCRIPTEN__
