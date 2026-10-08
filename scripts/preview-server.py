# Local preview that behaves like Cloudflare (/merge-pdf opens merge-pdf.html).
# Run from anywhere:  python scripts/preview-server.py   then open http://localhost:8765
import http.server, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0].split('#')[0]
        if path != '/' and '.' not in os.path.basename(path) and os.path.exists(path.lstrip('/') + '.html'):
            self.path = path + '.html'
        return super().do_GET()
    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
