import http.server
import functools
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

handler = http.server.SimpleHTTPRequestHandler
handler.extensions_map['.js'] = 'application/javascript'
handler.extensions_map['.mjs'] = 'application/javascript'

print("Serving at http://localhost:8000")
http.server.HTTPServer(('', 8000), handler).serve_forever()
