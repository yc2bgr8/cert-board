"""Linux job controls. Refuse execution if the required restrictions are unavailable."""

import ctypes as c
import errno
import os
import platform
import socket


_LIBC = c.CDLL(None, use_errno=True)
_SECCOMP = c.CDLL("libseccomp.so.2")
_SECCOMP.seccomp_init.argtypes = [c.c_uint32]
_SECCOMP.seccomp_init.restype = c.c_void_p
_SECCOMP.seccomp_syscall_resolve_name.argtypes = [c.c_char_p]
_SECCOMP.seccomp_syscall_resolve_name.restype = c.c_int
_SECCOMP.seccomp_load.argtypes = [c.c_void_p]
_SECCOMP.seccomp_release.argtypes = [c.c_void_p]
_SECCOMP.seccomp_release.restype = None

_CREATE_RULESET = 444
_ADD_RULE = 445
_RESTRICT_SELF = 446
_RULE_PATH_BENEATH = 1
_BIND_TCP = 1
_CONNECT_TCP = 2
_SCOPE_SIGNAL = 2
_SCOPE_ABSTRACT_UNIX = 1

_WRITE = 1 << 1
_OUTPUT_RIGHTS = _WRITE | sum(1 << bit for bit in (4, 5, 7, 8, 9, 10, 12, 13, 14))
_HANDLED_FILES = _OUTPUT_RIGHTS | (1 << 6) | (1 << 11)

_ALLOW = 0x7FFF0000
_RETURN_ERROR = 0x00050000
_CMP_NE = 1
_CMP_MASKED_EQ = 7


class _Ruleset(c.Structure):
    _fields_ = [("files", c.c_uint64), ("network", c.c_uint64), ("scope", c.c_uint64)]


class _PathRule(c.Structure):
    _pack_ = 1
    _fields_ = [("allowed", c.c_uint64), ("parent_fd", c.c_int32)]


class _Compare(c.Structure):
    _fields_ = [("argument", c.c_uint), ("operator", c.c_uint), ("first", c.c_uint64), ("second", c.c_uint64)]


_SECCOMP.seccomp_rule_add_array.argtypes = [c.c_void_p, c.c_uint32, c.c_int, c.c_uint, c.POINTER(_Compare)]
_SECCOMP.seccomp_rule_add_array.restype = c.c_int


def _syscall(number, *args):
    result = _LIBC.syscall(number, *args)
    if result < 0:
        raise OSError(c.get_errno(), "sandbox isolation")
    return result


def _restrict_landlock(output, temporary):
    if platform.machine() not in {"x86_64", "aarch64"} or _syscall(_CREATE_RULESET, 0, 0, 1) < 6:
        raise OSError("Required Landlock ABI is unavailable")
    config = _Ruleset(_HANDLED_FILES, _BIND_TCP | _CONNECT_TCP, _SCOPE_ABSTRACT_UNIX | _SCOPE_SIGNAL)
    descriptor = _syscall(_CREATE_RULESET, c.byref(config), c.sizeof(config), 0)
    try:
        for path in (output, temporary):
            directory = os.open(path, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                rule = _PathRule(_OUTPUT_RIGHTS, directory)
                _syscall(_ADD_RULE, descriptor, _RULE_PATH_BENEATH, c.byref(rule), 0)
            finally:
                os.close(directory)
        _syscall(_RESTRICT_SELF, descriptor, 0)
    finally:
        os.close(descriptor)


def _restrict_syscalls():
    context = _SECCOMP.seccomp_init(_ALLOW)
    if not context:
        raise OSError("Cannot allocate seccomp filter")

    def deny(syscall, *comparisons, error=errno.EPERM):
        number = _SECCOMP.seccomp_syscall_resolve_name(syscall.encode("ascii"))
        if number < 0:
            raise OSError("Required system-call symbol is unavailable")
        rules = (_Compare * len(comparisons))(*comparisons)
        result = _SECCOMP.seccomp_rule_add_array(context, _RETURN_ERROR | error, number, len(rules), rules)
        if result < 0:
            raise OSError(-result, "Cannot restrict sandbox system call")

    try:
        for name in ("setsid", "setpgid", "setns", "unshare", "ptrace", "process_vm_readv",
                     "process_vm_writev", "pidfd_getfd", "io_uring_setup", "userfaultfd", "bpf"):
            deny(name)
        deny("clone3", error=errno.ENOSYS)
        for flag in (0x20000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000):
            deny("clone", _Compare(0, _CMP_MASKED_EQ, flag, flag))
        deny("socketpair", _Compare(0, _CMP_NE, socket.AF_UNIX, 0))
        deny("socket", _Compare(0, _CMP_NE, socket.AF_UNIX, 0))
        result = _SECCOMP.seccomp_load(context)
        if result < 0:
            raise OSError(-result, "Cannot load sandbox filter")
    finally:
        _SECCOMP.seccomp_release(context)


def constrain(output, temporary):
    if _LIBC.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(c.get_errno(), "Cannot set no-new-privileges")
    _restrict_landlock(output, temporary)
    _restrict_syscalls()
