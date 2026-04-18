#!/usr/bin/env python3
"""
Dev server for UZDoom WASM.

Serves the build-wasm/ output with the COOP + COEP headers required to enable
SharedArrayBuffer / pthreads in all modern browsers.

Usage:
    python web/serve.py [port]

Default port: 8080. Default served dir: ../build-wasm/ relative to this file.
"""
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class CrossOriginIsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            self.send_response(302)
            self.send_header('Location', '/uzdoom.html')
            self.end_headers()
            return
        super().do_GET()

    def guess_type(self, path):
        if path.endswith('.wasm'):
            return 'application/wasm'
        if path.endswith('.data'):
            return 'application/octet-stream'
        return super().guess_type(path)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    # Walk upward from this file to find a sibling build-wasm/ dir.
    here = os.path.dirname(os.path.abspath(__file__))
    serve_dir = None
    probe = here
    for _ in range(6):
        cand = os.path.join(probe, 'build-wasm')
        if os.path.isdir(cand):
            serve_dir = cand
            break
        probe = os.path.dirname(probe)
    if serve_dir is None:
        print('Build dir not found. Run ./build-wasm.sh first.', file=sys.stderr)
        sys.exit(1)
    os.chdir(serve_dir)
    print(f'Serving {serve_dir} on http://localhost:{port}')
    print('(COOP/COEP/CORP headers enabled — SharedArrayBuffer will work.)')
    HTTPServer(('0.0.0.0', port), CrossOriginIsolatedHandler).serve_forever()


if __name__ == '__main__':
    main()
