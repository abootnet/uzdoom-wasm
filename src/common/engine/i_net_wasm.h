#pragma once
// WebSocket transport shim for the engine's UDP netcode (Emscripten only).
#ifdef __EMSCRIPTEN__
#include <netinet/in.h>
#include <sys/types.h>

int  uznet_socket();                                   // starts the transport
void uznet_close();
int  uznet_sendto(const void* buf, size_t len, const sockaddr_in* to);
int  uznet_recvfrom(void* buf, size_t cap, sockaddr_in* from, unsigned short port);
#endif
