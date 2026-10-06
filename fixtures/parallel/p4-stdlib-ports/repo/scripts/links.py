"""Legacy link checker helpers (to be replaced by src/urlparse)."""
import sys
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit

base = sys.argv[1]
for href in sys.stdin.read().split():
    url = urljoin(base, href)
    parts = urlsplit(url)
    print(parts.hostname, parts.port, urlencode(sorted(parse_qsl(parts.query))))
