"""Python bridge for reference/check-harness.mjs: runs one documented JS call against CPython and prints the JS-shaped result.

Not a solution (solutions must not call Python); it proves that the hidden harness, the documented JS shapes and the generated
expectations agree. Usage: python3 bridge.py <module> <fn> <json args> [<json ctor>]
"""
import difflib
import json
import shlex
import sys
import textwrap
import urllib.parse as up

CAMEL = {"initialIndent": "initial_indent", "subsequentIndent": "subsequent_indent", "expandTabs": "expand_tabs",
         "replaceWhitespace": "replace_whitespace", "fixSentenceEndings": "fix_sentence_endings",
         "breakLongWords": "break_long_words", "dropWhitespace": "drop_whitespace", "breakOnHyphens": "break_on_hyphens",
         "maxLines": "max_lines", "keepBlankValues": "keep_blank_values", "strictParsing": "strict_parsing",
         "maxNumFields": "max_num_fields"}


def kw(options):
    return {CAMEL.get(key, key): value for key, value in (options or {}).items()}


def split_shape(parts):
    shape = {key: getattr(parts, key) for key in ("scheme", "netloc", "path", "query", "fragment", "username", "password", "hostname", "port")}
    if hasattr(parts, "params"):
        shape["params"] = parts.params
    return shape


def run(module, fn, args, ctor):
    if module == "textwrap":
        if fn in ("wrap", "fill"):
            return getattr(textwrap, fn)(args[0], **kw(args[1] if len(args) > 1 else {}))
        if fn == "shorten":
            return textwrap.shorten(args[0], args[1], **kw(args[2] if len(args) > 2 else {}))
        return getattr(textwrap, fn)(*args)
    if module == "shlex":
        if fn == "split":
            return shlex.split(args[0], **kw(args[1] if len(args) > 1 else {}))
        return getattr(shlex, fn)(*args)
    if module == "difflib":
        if fn.startswith("SequenceMatcher."):
            a, b, options = ctor
            matcher = difflib.SequenceMatcher(None, a, b, autojunk=options.get("autojunk", True))
            method = {"getMatchingBlocks": "get_matching_blocks", "getOpcodes": "get_opcodes", "getGroupedOpcodes": "get_grouped_opcodes",
                      "ratio": "ratio", "quickRatio": "quick_ratio", "findLongestMatch": "find_longest_match"}[fn.split(".")[1]]
            result = getattr(matcher, method)(*args)
            if method == "get_grouped_opcodes":
                return [[list(op) for op in group] for group in result]
            if method in ("get_matching_blocks", "get_opcodes"):
                return [list(item) for item in result]
            return list(result) if method == "find_longest_match" else result
        if fn in ("unifiedDiff", "contextDiff"):
            return list(getattr(difflib, "unified_diff" if fn == "unifiedDiff" else "context_diff")(args[0], args[1], **kw(args[2] if len(args) > 2 else {})))
        if fn == "ndiff":
            return list(difflib.ndiff(args[0], args[1]))
        if fn == "restore":
            return list(difflib.restore(*args))
        if fn == "getCloseMatches":
            return difflib.get_close_matches(*args)
    if module == "urlparse":
        if fn == "urlsplit":
            return split_shape(up.urlsplit(args[0], args[1] if len(args) > 1 else "", args[2] if len(args) > 2 else True))
        if fn == "urlparse":
            return split_shape(up.urlparse(*args))
        if fn == "urldefrag":
            result = up.urldefrag(*args)
            return {"url": result.url, "fragment": result.fragment}
        if fn in ("urlunsplit", "urlunparse", "urljoin", "quote", "unquote"):
            return getattr(up, fn)(*args)
        if fn in ("quotePlus", "unquotePlus"):
            return getattr(up, "quote_plus" if fn == "quotePlus" else "unquote_plus")(*args)
        if fn == "urlencode":
            query = args[0] if isinstance(args[0], dict) else [tuple(pair) for pair in args[0]]
            return up.urlencode(query, **kw(args[1] if len(args) > 1 else {}))
        if fn == "parseQsl":
            return [list(pair) for pair in up.parse_qsl(args[0], **kw(args[1] if len(args) > 1 else {}))]
        if fn == "parseQs":
            return up.parse_qs(args[0], **kw(args[1] if len(args) > 1 else {}))
    raise RuntimeError(f"bridge: unknown {module}.{fn}")


module, fn, args = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
ctor = json.loads(sys.argv[4]) if len(sys.argv) > 4 else None
try:
    print(json.dumps({"value": run(module, fn, args, ctor)}))
except Exception as error:  # noqa: BLE001
    print(json.dumps({"error": type(error).__name__, "message": str(error)}))
