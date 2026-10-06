#!/usr/bin/env python3
"""Hidden and visible cases of fixtures/parallel/p4-stdlib-ports (docs/orchestrator.md 8), generated from CPython itself.

Usage: python3 gen-cases.py  (writes hidden/test/acceptance-cases.json and repo/test/smoke-cases.json; deterministic seed)
Every expected value is what the installed CPython returns; errors are recorded as {"error": "<exception class name>"}.
"""
import difflib
import json
import random
import shlex
import signal
import sys
import textwrap
import urllib.parse as up
from pathlib import Path

HERE = Path(__file__).resolve().parent
rng = random.Random(20261006)


class Hang(BaseException):
    """CPython itself does not terminate on this input (textwrap loops forever on some option mixes): the case is dropped."""


def _alarm(_signum, _frame):
    raise Hang()


signal.signal(signal.SIGALRM, _alarm)
skipped = 0


def call(fn, *args, **kwargs):
    signal.setitimer(signal.ITIMER_REAL, 0.5)
    try:
        return {"value": fn(*args, **kwargs)}
    except Hang:
        return None
    except Exception as error:  # noqa: BLE001 - every exception class is part of the contract
        return {"error": type(error).__name__}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


cases = []


def add(module, name, args, result, ctor=None):
    global skipped
    if result is None:
        skipped += 1
        return
    case = {"module": module, "fn": name, "args": args, **result}
    if ctor is not None:
        case["ctor"] = ctor
    cases.append(case)


# ---------------------------------------------------------------- textwrap + shlex
WORDS = ["alpha", "beta", "gamma", "delta", "x", "to", "be", "re-enter", "well-known", "e-mail", "--option", "a-b-c-d",
         "supercalifragilisticexpialidocious", "Mr.", "end.", "Why?", "Stop!", "etc.", "(paren)", "'quoted'", "x--y", "1,000",
         "3.14", "naïve", "über", "日本語", "foo-", "-bar"]
SEPS = [" ", " ", " ", "  ", "\t", "\n", " \n ", "   "]


def random_text(words=12):
    out = []
    for _ in range(rng.randint(1, words)):
        out.append(rng.choice(WORDS))
        out.append(rng.choice(SEPS))
    text = "".join(out)
    if rng.random() < 0.3:
        text = rng.choice(["  ", "\t", "\n"]) + text
    return text


TEXTWRAP_OPTIONS = {"width": "width", "initialIndent": "initial_indent", "subsequentIndent": "subsequent_indent",
                    "expandTabs": "expand_tabs", "tabsize": "tabsize", "replaceWhitespace": "replace_whitespace",
                    "fixSentenceEndings": "fix_sentence_endings", "breakLongWords": "break_long_words",
                    "dropWhitespace": "drop_whitespace", "breakOnHyphens": "break_on_hyphens", "maxLines": "max_lines",
                    "placeholder": "placeholder"}


def random_options():
    options = {"width": rng.choice([1, 3, 5, 8, 10, 12, 15, 20, 25, 30, 40, 70])}
    for key, choices in [("initialIndent", ["", "  ", "* ", ">>> "]), ("subsequentIndent", ["", "  ", "    ", "| "]),
                         ("expandTabs", [True, False]), ("tabsize", [8, 4, 2]), ("replaceWhitespace", [True, False]),
                         ("fixSentenceEndings", [False, True]), ("breakLongWords", [True, False]),
                         ("dropWhitespace", [True, False]), ("breakOnHyphens", [True, False]),
                         ("maxLines", [None, 1, 2, 3]), ("placeholder", [" [...]", "...", " ~"])]:
        if rng.random() < 0.35:
            value = rng.choice(choices)
            if value is not None:
                options[key] = value
    return options


def py_options(options):
    return {TEXTWRAP_OPTIONS[key]: value for key, value in options.items()}


for _ in range(170):
    text, options = random_text(), random_options()
    fn = rng.choice(["wrap", "wrap", "fill"])
    add("textwrap", fn, [text, options], call(getattr(textwrap, fn), text, **py_options(options)))
for _ in range(40):
    text, width = random_text(16), rng.choice([5, 8, 10, 12, 15, 20, 30, 50])
    options = {key: value for key, value in random_options().items() if key not in ("width", "maxLines")}
    add("textwrap", "shorten", [text, width, options], call(textwrap.shorten, text, width, **py_options(options)))
for _ in range(30):
    lines = []
    for _ in range(rng.randint(1, 6)):
        indent = rng.choice(["", " ", "  ", "    ", "\t", " \t", "        "])
        lines.append(indent + rng.choice(["", "x", "alpha beta", "  ", "\t", "end"]))
    text = rng.choice(["\n", "\r\n" if rng.random() < 0.1 else "\n"]).join(lines) + rng.choice(["", "\n"])
    add("textwrap", "dedent", [text], call(textwrap.dedent, text))
for _ in range(20):
    text = "\n".join(rng.choice(["a", "", "  ", "b c", "\t"]) for _ in range(rng.randint(1, 5))) + rng.choice(["", "\n"])
    prefix = rng.choice(["> ", "  ", "#"])
    add("textwrap", "indent", [text, prefix], call(textwrap.indent, text, prefix))

SHLEX_TOKENS = ["a", "b c", "'single quoted'", '"double quoted"', '"esc \\" q"', "back\\ slash", "x#y", "# comment", "'a'\"b\"c",
                "$HOME", "*.txt", "'", '"', "\\", "''", '""', "a\\nb", '"\\$x"', "'\\'", "--flag=1", "ü"]
for _ in range(70):
    text = " ".join(rng.choice(SHLEX_TOKENS) for _ in range(rng.randint(1, 5)))
    options = {}
    if rng.random() < 0.3:
        options["comments"] = True
    if rng.random() < 0.3:
        options["posix"] = False
    add("shlex", "split", [text, options], call(shlex.split, text, **options))
for value in ["", "a", "a b", "it's", 'say "hi"', "$x", "safe-chars_.:/+@%=,", "tab\there", "ü", "a'b\"c", "-n", "~/x", "*", "[a]"]:
    add("shlex", "quote", [value], call(shlex.quote, value))
for _ in range(10):
    parts = [rng.choice(["a", "b c", "it's", "", "$x", "--o=1"]) for _ in range(rng.randint(1, 4))]
    add("shlex", "join", [parts], call(shlex.join, parts))

# ---------------------------------------------------------------- difflib
LINES = ["import os", "import sys", "def main():", "    return 0", "    pass", "", "# comment", "x = 1", "x = 2", "y = x + 1",
         "print(x)", "print(y)", "if __name__ == '__main__':", "    main()", "class A:", "    def f(self):", "        return 1"]


def random_lines(count):
    return [rng.choice(LINES) + "\n" for _ in range(count)]


def mutate(lines):
    out = list(lines)
    for _ in range(rng.randint(0, 4)):
        op = rng.random()
        index = rng.randint(0, len(out))
        if op < 0.35 and out:
            del out[min(index, len(out) - 1)]
        elif op < 0.7:
            out.insert(index, rng.choice(LINES) + "\n")
        elif out:
            position = min(index, len(out) - 1)
            line = out[position]
            out[position] = (line[:-1] + rng.choice(["  ", "x", "  # changed", ""])) + "\n"
    return out


def random_chars(count):
    return "".join(rng.choice("abcde ") for _ in range(count))


for _ in range(60):
    if rng.random() < 0.5:
        a = random_chars(rng.randint(0, 25))
        b = "".join(c if rng.random() < 0.8 else rng.choice("abcdef") for c in a) + random_chars(rng.randint(0, 4))
    else:
        a = random_lines(rng.randint(0, 14))
        b = mutate(a)
    autojunk = rng.random() < 0.8
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=autojunk)
    ctor = [a, b, {"autojunk": autojunk}]
    add("difflib", "SequenceMatcher.getMatchingBlocks", [], {"value": [list(block) for block in matcher.get_matching_blocks()]}, ctor)
    add("difflib", "SequenceMatcher.getOpcodes", [], {"value": [list(op) for op in matcher.get_opcodes()]}, ctor)
    add("difflib", "SequenceMatcher.ratio", [], {"value": matcher.ratio()}, ctor)
    add("difflib", "SequenceMatcher.quickRatio", [], {"value": matcher.quick_ratio()}, ctor)
    n = rng.choice([0, 1, 3])
    add("difflib", "SequenceMatcher.getGroupedOpcodes", [n], {"value": [[list(op) for op in group] for group in matcher.get_grouped_opcodes(n)]}, ctor)
# autojunk: popular elements of sequences with 200+ items
for _ in range(6):
    a = [rng.choice(["x\n", "y\n", "z\n"]) for _ in range(rng.randint(200, 260))] + random_lines(5)
    b = mutate(a)
    for autojunk in (True, False):
        matcher = difflib.SequenceMatcher(None, a, b, autojunk=autojunk)
        add("difflib", "SequenceMatcher.getOpcodes", [], {"value": [list(op) for op in matcher.get_opcodes()]}, [a, b, {"autojunk": autojunk}])
for _ in range(10):
    a, b = random_chars(rng.randint(5, 30)), random_chars(rng.randint(5, 30))
    matcher = difflib.SequenceMatcher(None, a, b)
    alo, ahi = sorted(rng.sample(range(len(a) + 1), 2))
    blo, bhi = sorted(rng.sample(range(len(b) + 1), 2))
    add("difflib", "SequenceMatcher.findLongestMatch", [alo, ahi, blo, bhi], {"value": list(matcher.find_longest_match(alo, ahi, blo, bhi))}, [a, b, {}])
for _ in range(40):
    a = random_lines(rng.randint(0, 16))
    b = mutate(a)
    options = {}
    if rng.random() < 0.5:
        options.update(fromfile="a/x.py", tofile="b/x.py")
    if rng.random() < 0.2:
        options.update(fromfiledate="2026-10-01", tofiledate="2026-10-02")
    if rng.random() < 0.4:
        options["n"] = rng.choice([0, 1, 2, 5])
    if rng.random() < 0.2:
        options["lineterm"] = ""
    fn = rng.choice(["unified_diff", "context_diff"])
    name = "unifiedDiff" if fn == "unified_diff" else "contextDiff"
    add("difflib", name, [a, b, options], call(lambda: list(getattr(difflib, fn)(a, b, **options))))
for _ in range(30):
    a = random_lines(rng.randint(0, 10))
    b = mutate(a)
    add("difflib", "ndiff", [a, b], call(lambda: list(difflib.ndiff(a, b))))
for _ in range(15):
    word = rng.choice(["appel", "apple", "pineapple", "wheel", "while", "lambda", "for", "import", "except"])
    possibilities = rng.sample(["ape", "apple", "peach", "puppy", "while", "wheel", "whale", "lambda", "for", "fork", "import", "exec", "except", "accept"], 8)
    n, cutoff = rng.choice([1, 2, 3]), rng.choice([0.0, 0.6, 0.8])
    add("difflib", "getCloseMatches", [word, possibilities, n, cutoff], call(difflib.get_close_matches, word, possibilities, n, cutoff))
for _ in range(10):
    a = random_lines(rng.randint(1, 8))
    b = mutate(a)
    delta = list(difflib.ndiff(a, b))
    which = rng.choice([1, 2])
    add("difflib", "restore", [delta, which], call(lambda: list(difflib.restore(delta, which))))

# ---------------------------------------------------------------- urllib.parse
URLS = ["http://www.example.com/path/to;params?q=1&r=2#frag", "https://user:pw@Host.Example:8080/p?x#y", "//netloc/only",
        "mailto:someone@example.com", "file:///etc/hosts", "http://[::1]:80/ipv6", "http://[fe80::1%25eth0]/zone",
        "http://[::1/broken", "http://host:notaport/", "http://host:99999/", "http://host:/empty-port", "  http://lead.space/",
        "ht\ttp://tab.example/", "relative/path?q", "/abs/path#f", "?only-query", "#only-frag", "", "a:b", "a1+-.:x",
        "1a:b", "path:with:colons", "HTTP://UPPER.case/", "http://h/%7Euser/a%2fb", "http://h/p?q=a+b%20c#f#g",
        "svn+ssh://svn.example/repo", "http://u@h", "http://u:@h", "http://:p@h", "http://h?q", "http://h#f",
        "data:text/plain;base64,SGk=", "http://a/b/c/d;p?q", "javascript:alert(1)", "http://h/\u00e9t\u00e9", "http://h\nx/"]
BASES = ["http://a/b/c/d;p?q", "http://a/b/c/d", "https://h/dir/", "file:///tmp/x", "", "http://a", "mailto:x@y"]
REFS = ["g:h", "g", "./g", "g/", "/g", "//g", "?y", "g?y", "#s", "g#s", "g?y#s", ";x", "g;x", "", ".", "./", "..", "../",
        "../g", "../..", "../../", "../../g", "../../../g", "../../../../g", "/./g", "/../g", "g.", ".g", "g..", "..g",
        "./../g", "./g/.", "g/./h", "g/../h", "g;x=1/./y", "g;x=1/../y", "g?y/./x", "g?y/../x", "g#s/./x", "http:g",
        "https://other/x", "//other", "mailto:z"]
for url in URLS:
    for allow in (True, False):
        def split(url=url, allow=allow):
            parts = up.urlsplit(url, allow_fragments=allow)
            return {"scheme": parts.scheme, "netloc": parts.netloc, "path": parts.path, "query": parts.query,
                    "fragment": parts.fragment, "username": parts.username, "password": parts.password,
                    "hostname": parts.hostname, "port": parts.port}
        add("urlparse", "urlsplit", [url, "", allow], call(split))
    # The documented JS result carries .port, read when the result is created: an invalid port throws there too.
    def tuple_of(parts):
        parts.port
        return list(parts)
    add("urlparse", "urlparse", [url], call(lambda url=url: tuple_of(up.urlparse(url))))
    add("urlparse", "urlsplit", [url, "ftp", True], call(lambda url=url: tuple_of(up.urlsplit(url, "ftp"))[:5]))
    add("urlparse", "urldefrag", [url], call(lambda url=url: list(up.urldefrag(url))))
for url in URLS[:20]:
    try:
        parts = list(up.urlsplit(url))
    except ValueError:
        continue
    add("urlparse", "urlunsplit", [parts], call(up.urlunsplit, parts))
    parsed = list(up.urlparse(url))
    add("urlparse", "urlunparse", [parsed], call(up.urlunparse, parsed))
for base in BASES:
    for ref in REFS:
        if base not in BASES[:2] and rng.random() < 0.6:
            continue
        add("urlparse", "urljoin", [base, ref, True], call(up.urljoin, base, ref))
QUOTE_STRINGS = ["", "abc", "a b", "a+b", "a/b", "~user", "100%", "é", "日本", "a&b=c", "!*'();:@&=+$,/?#[]", "\u0000\x7f", "-_.~"]
for value in QUOTE_STRINGS:
    for safe in ("/", "", ":/?=&"):
        add("urlparse", "quote", [value, safe], call(up.quote, value, safe))
    add("urlparse", "quotePlus", [value, ""], call(up.quote_plus, value, ""))
UNQUOTE_STRINGS = ["", "abc", "a%20b", "a+b", "%7e", "%E6%97%A5%E6%9C%AC", "%e9", "%zz", "%", "%4", "100%25", "%C3%A9%",
                   "%f0%9f%98%80", "%ED%A0%80", "a%2Bb+c"]
for value in UNQUOTE_STRINGS:
    add("urlparse", "unquote", [value], call(up.unquote, value))
    add("urlparse", "unquotePlus", [value], call(up.unquote_plus, value))
QS = ["a=1&b=2", "a=1&a=2&b", "a=&b=", "=x", "a=1;b=2", "a%20b=c+d", "&&a=1&&", "a=%E6%97%A5", "a", "a=1&b", "x=%zz",
      "a=b=c", "", "k=v&k2=v2&k3=v3"]
for qs in QS:
    for keep in (False, True):
        for strict in (False, True):
            add("urlparse", "parseQsl", [qs, {"keepBlankValues": keep, "strictParsing": strict}],
                call(lambda qs=qs, keep=keep, strict=strict: [list(pair) for pair in up.parse_qsl(qs, keep_blank_values=keep, strict_parsing=strict)]))
    add("urlparse", "parseQs", [qs, {"keepBlankValues": True}], call(up.parse_qs, qs, keep_blank_values=True))
    add("urlparse", "parseQsl", [qs, {"separator": ";"}], call(lambda qs=qs: [list(pair) for pair in up.parse_qsl(qs, separator=";")]))
add("urlparse", "parseQsl", ["a=1&b=2&c=3", {"maxNumFields": 2}], call(up.parse_qsl, "a=1&b=2&c=3", max_num_fields=2))
for pairs, doseq in [([["a", "1"], ["b", "x y"]], False), ([["a", ["1", "2"]], ["b", "é"]], True), ([["a", ["1", "2"]]], False),
                     ([["k&", "v="], ["~", "/"]], False), ([], False), ([["sp ace", "+plus"]], True)]:
    add("urlparse", "urlencode", [pairs, {"doseq": doseq}], call(lambda pairs=pairs, doseq=doseq: up.urlencode([tuple(p) for p in pairs], doseq=doseq)))
add("urlparse", "urlencode", [[["a", "/x y"]], {"safe": "/"}], call(up.urlencode, [("a", "/x y")], safe="/"))

# ---------------------------------------------------------------- write
visible = [case for index, case in enumerate(cases) if index % 9 == 0]
(HERE / "hidden/test").mkdir(parents=True, exist_ok=True)
(HERE / "repo/test").mkdir(parents=True, exist_ok=True)
meta = {"python": sys.version.split()[0], "seed": 20261006}
(HERE / "hidden/test/acceptance-cases.json").write_text(json.dumps({**meta, "cases": cases}, ensure_ascii=False) + "\n")
(HERE / "repo/test/smoke-cases.json").write_text(json.dumps({**meta, "cases": visible}, ensure_ascii=False, indent=0) + "\n")
counts = {}
for case in cases:
    counts[case["module"]] = counts.get(case["module"], 0) + 1
print(json.dumps({"total": len(cases), "visible": len(visible), "byModule": counts, "skippedNonTerminating": skipped, **meta}))
