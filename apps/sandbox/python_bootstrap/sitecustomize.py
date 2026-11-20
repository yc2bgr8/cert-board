"""Keep Python file copies compatible with descriptor-only permission changes."""

import os


def chmod(path, mode, *, dir_fd=None, follow_symlinks=True):
    # 只能对取得普通读取权限的描述符改模式，内核禁止按路径直接改权限。
    if isinstance(path, int):
        if dir_fd is not None or not follow_symlinks:
            raise ValueError("descriptor chmod does not accept path options")
        os.fchmod(path, mode)
        return
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC
    if not follow_symlinks:
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, dir_fd=dir_fd)
    try:
        os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)


os.chmod = chmod
