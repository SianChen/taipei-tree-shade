"""Serve web/ for local preview with caching off, so an edited app.js or style.css shows up on a normal reload.

python3 -m http.server sends no Cache-Control, so browsers may keep an old style.css for hours.

Usage: python3 scripts/serve_web.py [--port 8765]
"""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')  # revalidate every time; unchanged files still come back as 304
        super().end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    args = ap.parse_args()
    web = Path(__file__).resolve().parent.parent / 'web'
    handler = functools.partial(NoCacheHandler, directory=str(web))
    with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as httpd:
        print(f'serving {web} at http://127.0.0.1:{args.port}/', flush=True)
        httpd.serve_forever()


if __name__ == '__main__':
    main()
