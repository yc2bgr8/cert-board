"""Start one user program after dropping ambient access."""

import os
import resource
import runpy
import sys
from pathlib import Path

from isolation import constrain


MEMORY_LIMIT = 768 * 1024 * 1024
FILE_LIMIT = 16 * 1024 * 1024


def main():
    root, seconds, report = sys.argv[1:]
    work = Path(root)
    duration = int(seconds)
    try:
        Path("/proc/self/oom_score_adj").write_text("500", encoding="ascii")
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
        resource.setrlimit(resource.RLIMIT_CPU, (duration, duration + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_LIMIT, FILE_LIMIT))
        resource.setrlimit(resource.RLIMIT_NOFILE, (96, 96))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.set_inheritable(int(report), False)
        constrain(work)
        os.write(int(report), b"R")
    except Exception:
        sys.stderr.write("SANDBOX_SETUP_FAILED\n")
        return 126
    try:
        runpy.run_path(str(work / "program.py"), run_name="__main__")
    except MemoryError:
        os.write(int(report), b"M")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
