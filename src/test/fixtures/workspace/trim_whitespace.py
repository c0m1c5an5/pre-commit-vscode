import re
import sys

for path in sys.argv[1:]:
    text = open(path).read()
    open(path, "w").write(re.sub(r"[ \t]+\n", "\n", text))
