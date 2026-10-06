"""Legacy changelog formatter (to be replaced by src/text)."""
import shlex
import sys
import textwrap

for line in sys.stdin:
    command, _, note = line.partition("\t")
    print(textwrap.fill(note.strip(), width=72, initial_indent="- ", subsequent_indent="  "))
    print("  $ " + shlex.join(shlex.split(command)))
