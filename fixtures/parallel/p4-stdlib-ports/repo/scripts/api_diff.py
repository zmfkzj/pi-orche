"""Legacy API diff report (to be replaced by src/difflib)."""
import difflib
import sys

old, new = (open(path).readlines() for path in sys.argv[1:3])
sys.stdout.writelines(difflib.unified_diff(old, new, fromfile=sys.argv[1], tofile=sys.argv[2]))
