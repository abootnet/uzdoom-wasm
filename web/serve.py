#!/usr/bin/env python3
"""
Dev server for UZDoom WASM.

Serves the build-wasm/ output with the COOP + COEP headers required to enable
SharedArrayBuffer / pthreads in all modern browsers.

Usage:
    python web/serve.py [port]
    python web/serve.py [port] --cert <pem> --key <pem>

Default port: 8080. Default served dir: ../build-wasm/ relative to this file.

When --cert/--key are provided (or a ./localhost.pem / ./localhost-key.pem pair
exists next to this script), the server runs over HTTPS. This is the only way
to get a working SharedArrayBuffer page on devices other than the dev machine
itself — browsers refuse to flip the `crossOriginIsolated` flag on plain HTTP
unless the host is `localhost`, even when the COOP/COEP headers are present.

For a no-third-party local-network HTTPS setup:
    1. brew install mkcert        # or `winget install FiloSottile.mkcert`
    2. mkcert -install            # one-time root CA install into your trust store
    3. cd web/  &&  mkcert localhost 127.0.0.1 <YOUR-LAN-IP>
       -> produces localhost+2.pem and localhost+2-key.pem
    4. python web/serve.py --cert web/localhost+2.pem --key web/localhost+2-key.pem
    5. On the phone, install the mkcert root cert (mkcert -CAROOT prints its
       path; AirDrop / sideload it to the device's profile / cert store) so
       Safari/Chrome trust the LAN cert.

For a no-cert alternative, run `cloudflared tunnel --url http://localhost:8080`
in another terminal and use the printed https://*.trycloudflare.com URL.
"""
import argparse
import os
import ssl
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


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


def find_build_dir(start):
    """Walk upward from `start` looking for a sibling build-wasm/ dir."""
    probe = start
    for _ in range(6):
        cand = os.path.join(probe, 'build-wasm')
        if os.path.isdir(cand):
            return cand
        probe = os.path.dirname(probe)
    return None


def autodetect_cert(here):
    """Look for a conventional cert/key pair next to serve.py."""
    candidates = [
        ('localhost.pem',      'localhost-key.pem'),
        ('localhost+1.pem',    'localhost+1-key.pem'),
        ('localhost+2.pem',    'localhost+2-key.pem'),
        ('localhost+3.pem',    'localhost+3-key.pem'),
    ]
    for cert_name, key_name in candidates:
        cert = os.path.join(here, cert_name)
        key  = os.path.join(here, key_name)
        if os.path.isfile(cert) and os.path.isfile(key):
            return cert, key
    return None, None


def main():
    parser = argparse.ArgumentParser(description='UZDoom WASM dev server')
    parser.add_argument('port', nargs='?', type=int, default=8080,
                        help='Port to listen on (default 8080)')
    parser.add_argument('--cert', help='Path to TLS cert (PEM). Enables HTTPS.')
    parser.add_argument('--key',  help='Path to TLS key (PEM). Enables HTTPS.')
    args = parser.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    serve_dir = find_build_dir(here)
    if serve_dir is None:
        print('Build dir not found. Run ./build-wasm.sh first.', file=sys.stderr)
        sys.exit(1)

    # Resolve cert/key. CLI args take priority; otherwise probe for a
    # conventional pair next to this script.
    cert = args.cert
    key  = args.key
    if not cert and not key:
        cert, key = autodetect_cert(here)

    if (cert and not key) or (key and not cert):
        print('Error: --cert and --key must be passed together.', file=sys.stderr)
        sys.exit(1)
    if cert and not os.path.isfile(cert):
        print(f'Cert file not found: {cert}', file=sys.stderr); sys.exit(1)
    if key and not os.path.isfile(key):
        print(f'Key file not found: {key}', file=sys.stderr);   sys.exit(1)

    os.chdir(serve_dir)
    scheme = 'https' if cert else 'http'
    print(f'Serving {serve_dir} on {scheme}://localhost:{args.port}')
    print('(COOP/COEP/CORP headers enabled — SharedArrayBuffer will work.)')
    if not cert:
        print('Note: only localhost will be `crossOriginIsolated`. '
              'For LAN/mobile testing use HTTPS (see --cert/--key in serve.py header).')

    # ThreadingHTTPServer (not HTTPServer): the Emscripten pthreads build
    # spawns multiple Web Workers that each fetch uzdoom.wasm /
    # uzdoom.worker.js in parallel during init. A single-threaded server
    # serializes those fetches, which on desktop resolves fast enough to
    # not matter but on mobile (slower request handling) can stall the
    # boot at "Launching engine…" indefinitely. Production Caddy is
    # multi-threaded — mirror that here so phones can hit the dev server
    # on the LAN too.
    httpd = ThreadingHTTPServer(('0.0.0.0', args.port), CrossOriginIsolatedHandler)

    if cert:
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(certfile=cert, keyfile=key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down.')


if __name__ == '__main__':
    main()
