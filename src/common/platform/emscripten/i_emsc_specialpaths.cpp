// Emscripten special-paths implementation for the UZDoom WASM build.
//
// All user-writable paths live under a single IDBFS-mounted directory so the
// browser's IndexedDB persists them across page loads. Data paths (bundled
// assets) live under MEMFS.
//
// Layout:
//   /doom/                         - bundled assets preloaded into MEMFS
//     iwads/                       - optional preloaded IWADs (freedoom1.wad)
//   /home/web_user/.config/uzdoom/ - IDBFS-backed (config, saves, cache)

#include <errno.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "cmdlib.h"
#include "i_system.h"
#include "i_specialpaths.h"
#include "printf.h"
#include "tarray.h"
#include "zstring.h"

#ifndef GAMENAMELOWERCASE
#define GAMENAMELOWERCASE "uzdoom"
#endif

static const char *kUserDir    = "/home/web_user/.config/" GAMENAMELOWERCASE;
static const char *kDataDir    = "/doom";
static const char *kCacheDir   = "/home/web_user/.config/" GAMENAMELOWERCASE "/cache";
static const char *kSavesDir   = "/home/web_user/.config/" GAMENAMELOWERCASE "/savegames";
static const char *kShotsDir   = "/home/web_user/.config/" GAMENAMELOWERCASE "/screenshots";

static void EnsureDir(const char *path)
{
	struct stat st;
	if (stat(path, &st) == 0) return;
	mkdir(path, S_IRUSR | S_IWUSR | S_IXUSR);
}

FString GetUserFile(const char *file)
{
	EnsureDir(kUserDir);
	FString path = kUserDir;
	path += "/";
	path += file;
	return path;
}

FString M_GetAppDataPath(bool create)
{
	if (create) EnsureDir(kUserDir);
	return FString(kUserDir);
}

FString M_GetCachePath(bool create)
{
	if (create) { EnsureDir(kUserDir); EnsureDir(kCacheDir); }
	return FString(kCacheDir);
}

FString M_GetAutoexecPath()
{
	return GetUserFile("autoexec.cfg");
}

FString M_GetConfigPath(bool /*for_reading*/)
{
	return GetUserFile(GAMENAMELOWERCASE ".ini");
}

FString M_GetDocumentsPath()
{
	FString p = kUserDir;
	p += "/";
	return p;
}

FString M_GetScreenshotsPath()
{
	EnsureDir(kUserDir);
	EnsureDir(kShotsDir);
	FString p = kShotsDir;
	p += "/";
	return p;
}

FString M_GetSavegamesPath()
{
	EnsureDir(kUserDir);
	EnsureDir(kSavesDir);
	FString p = kSavesDir;
	p += "/";
	return p;
}

FString M_GetDemoPath()
{
	return M_GetDocumentsPath() + "demo/";
}

FString M_GetNormalizedPath(const char *path)
{
	// Emscripten's realpath is usable but MEMFS/IDBFS paths are already
	// absolute and free of symlinks, so this collapses to identity.
	return FString(path ? path : "");
}

// Called from posix/sdl/i_system.cpp as a fallback dialog path — no GTK
// in a browser, so route to stderr and let the web shell surface it.
extern "C" bool I_GtkAvailable()
{
	return false;
}

extern "C" void I_ShowFatalError_Gtk(const char *errortext)
{
	if (errortext) fprintf(stderr, "UZDoom fatal: %s\n", errortext);
}

// d_main.cpp / gameconfigfile.cpp expect a GetDataPath() — route to the
// same IDBFS area the rest of the user data lives in.
const char * GetDataPath()
{
	EnsureDir(kUserDir);
	return kUserDir;
}

// d_iwad.cpp walks Steam / GOG install dirs on desktop. Browsers have
// neither, so return empty arrays and let the IWAD picker / upload flow
// do the work.
TArray<FString> I_GetSteamPath() { return {}; }
TArray<FString> I_GetGogPaths()  { return {}; }

// Crash-catcher install hook from posix/sdl/i_main.cpp. The browser has
// no usable signal-handler contract, so this is a no-op returning success.
extern "C" int cc_install_handlers(int, char**, int, int*, const char*,
	int (*)(char*, char*))
{
	return 0;
}
