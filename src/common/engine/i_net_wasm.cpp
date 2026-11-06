// WebSocket transport shim for the engine's UDP netcode.
//
// i_net.cpp calls socket/sendto/recvfrom with sockaddr_in addresses. In the
// browser there is no UDP, so those calls are redirected here. Each remote
// player is given a virtual address 10.0.0.(slot+1); the relay (see relay/)
// routes by slot. The WebSocket itself lives on a helper pthread
// (web/library_uznet.js) and talks to us through two shared-memory rings.
#ifdef __EMSCRIPTEN__

#include "i_net_wasm.h"

#include <arpa/inet.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <errno.h>
#include <pthread.h>
#include <string.h>
#include <unistd.h>

#include <atomic>

#include "engineerrors.h"
#include "printf.h"

namespace
{
constexpr int SLOTS = 64;
constexpr int SLOT_SIZE = 8192 + 4;          // 8000-byte engine packet + header
constexpr int BROADCAST = 0xFF;

// Must match the layout documented in web/library_uznet.js.
struct alignas(64) Ring
{
	volatile int32_t head;                    // @0
	char pad0[60];
	volatile int32_t tail;                    // @64
	char pad1[60];
	uint8_t slots[SLOTS][SLOT_SIZE];          // @128
};
static_assert(offsetof(Ring, head) == 0 && offsetof(Ring, tail) == 64 && offsetof(Ring, slots) == 128, "ring layout");

Ring rxRing;                                  // net thread -> engine
Ring txRing;                                  // engine -> net thread
volatile int32_t netState[4];                 // connected, slot, error, closed
bool started = false;
pthread_t netThread;
char urlBuf[2048];
}

extern "C"
{
	int uznet_js_get_url(char* buf, int cap);
	void uznet_js_connect(const char* url, void* rx, void* tx, void* st, int slots, int slotSize);
}

static void* NetThreadMain(void*)
{
	uznet_js_connect(urlBuf, &rxRing, &txRing, (void*)netState, SLOTS, SLOT_SIZE);
	// Keep this worker alive so its event loop keeps delivering WebSocket events.
	emscripten_exit_with_live_runtime();
	return nullptr;
}

int uznet_socket()
{
	if (started) return 1;
	if (!uznet_js_get_url(urlBuf, sizeof(urlBuf)))
		I_FatalError("Multiplayer is not available: no relay ticket. Join a lobby from the Multiplayer tab.");
	if (pthread_create(&netThread, nullptr, NetThreadMain, nullptr) != 0)
		I_FatalError("Could not start the network thread.");
	started = true;

	// Wait for the relay's hello (up to ~15 s). Only this thread blocks;
	// the worker keeps running independently.
	for (int i = 0; i < 1500; i++)
	{
		if (__atomic_load_n(&netState[0], __ATOMIC_ACQUIRE)) { Printf("Connected to relay as slot %d\n", netState[1]); return 1; }
		if (__atomic_load_n(&netState[2], __ATOMIC_ACQUIRE) || __atomic_load_n(&netState[3], __ATOMIC_ACQUIRE))
			I_FatalError("Could not connect to the multiplayer relay.");
		usleep(10000);
	}
	I_FatalError("Timed out connecting to the multiplayer relay.");
	return -1;
}

void uznet_close()
{
	__atomic_store_n(&netState[3], 1, __ATOMIC_RELEASE);
	started = false;
}

int uznet_sendto(const void* buf, size_t len, const sockaddr_in* to)
{
	if (len == 0 || len > (size_t)(SLOT_SIZE - 4)) { errno = EMSGSIZE; return -1; }
	uint32_t ip = ntohl(to->sin_addr.s_addr);
	int dest = (ip == INADDR_BROADCAST) ? BROADCAST : (int)(ip & 0xFF) - 1;
	if (dest < 0 || dest > BROADCAST) { errno = EHOSTUNREACH; return -1; }

	int32_t h = __atomic_load_n(&txRing.head, __ATOMIC_RELAXED);
	int32_t t = __atomic_load_n(&txRing.tail, __ATOMIC_ACQUIRE);
	int32_t nh = (h + 1) % SLOTS;
	if (nh == t) return (int)len;                 // ring full: drop like UDP
	uint8_t* s = txRing.slots[h];
	s[0] = len & 0xFF; s[1] = (len >> 8) & 0xFF; s[2] = (uint8_t)dest;
	memcpy(s + 4, buf, len);
	__atomic_store_n(&txRing.head, nh, __ATOMIC_RELEASE);
	emscripten_futex_wake((void*)&txRing.head, 1);
	return (int)len;
}

int uznet_recvfrom(void* buf, size_t cap, sockaddr_in* from, unsigned short port)
{
	int32_t t = __atomic_load_n(&rxRing.tail, __ATOMIC_RELAXED);
	int32_t h = __atomic_load_n(&rxRing.head, __ATOMIC_ACQUIRE);
	if (t == h) { errno = EWOULDBLOCK; return -1; }
	const uint8_t* s = rxRing.slots[t];
	size_t len = s[0] | (s[1] << 8);
	if (len > cap) len = cap;
	memcpy(buf, s + 4, len);
	if (from)
	{
		memset(from, 0, sizeof(*from));
		from->sin_family = AF_INET;
		from->sin_port = htons(port);
		from->sin_addr.s_addr = htonl(0x0A000000u | (uint32_t)(s[2] + 1));   // 10.0.0.(slot+1)
	}
	__atomic_store_n(&rxRing.tail, (t + 1) % SLOTS, __ATOMIC_RELEASE);
	return (int)len;
}

#endif // __EMSCRIPTEN__
