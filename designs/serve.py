#!/usr/bin/env python3
"""Serve this design workspace with Python's standard library."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class DesignHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Design files change frequently. Always fetch the current version.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=3010)
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    handler = partial(DesignHandler, directory=str(directory))
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError as error:
        parser.exit(1, f'Could not start preview: {error}. Try --port 3011.\n')
    print(f'Designs: http://localhost:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
