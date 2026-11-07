import ctypes as c
import json
import os
import subprocess
import sys
import uuid
from ctypes import wintypes as w

class STARTUPINFO(c.Structure):
    _fields_ = [('cb', w.DWORD), ('lpReserved', w.LPWSTR), ('lpDesktop', w.LPWSTR), ('lpTitle', w.LPWSTR), ('dwX', w.DWORD), ('dwY', w.DWORD), ('dwXSize', w.DWORD), ('dwYSize', w.DWORD), ('dwXCountChars', w.DWORD), ('dwYCountChars', w.DWORD), ('dwFillAttribute', w.DWORD), ('dwFlags', w.DWORD), ('wShowWindow', w.WORD), ('cbReserved2', w.WORD), ('lpReserved2', c.c_void_p), ('hStdInput', w.HANDLE), ('hStdOutput', w.HANDLE), ('hStdError', w.HANDLE)]
class PROCESS_INFORMATION(c.Structure):
    _fields_ = [('hProcess', w.HANDLE), ('hThread', w.HANDLE), ('dwProcessId', w.DWORD), ('dwThreadId', w.DWORD)]
class BASIC_LIMIT(c.Structure):
    _fields_ = [('processTime', c.c_int64), ('jobTime', c.c_int64), ('flags', w.DWORD), ('minWorking', c.c_size_t), ('maxWorking', c.c_size_t), ('active', w.DWORD), ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
class EXTENDED_LIMIT(c.Structure):
    _fields_ = [('basic', BASIC_LIMIT), ('io', c.c_uint64 * 6), ('processMemory', c.c_size_t), ('jobMemory', c.c_size_t), ('peakProcess', c.c_size_t), ('peakJob', c.c_size_t)]
u = c.WinDLL('user32', use_last_error=True)
k = c.WinDLL('kernel32', use_last_error=True)
u.CreateDesktopW.restype = w.HANDLE
u.CreateDesktopW.argtypes = [w.LPCWSTR, c.c_void_p, c.c_void_p, w.DWORD, w.DWORD, c.c_void_p]
u.CloseDesktop.argtypes = [w.HANDLE]
k.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR, c.POINTER(STARTUPINFO), c.POINTER(PROCESS_INFORMATION)]
k.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k.CloseHandle.argtypes = [w.HANDLE]
k.CreateJobObjectW.argtypes = [c.c_void_p,w.LPCWSTR]
k.CreateJobObjectW.restype = w.HANDLE
k.SetInformationJobObject.argtypes = [w.HANDLE,c.c_int,c.c_void_p,w.DWORD]
k.AssignProcessToJobObject.argtypes = [w.HANDLE,w.HANDLE]
k.ResumeThread.argtypes = [w.HANDLE]
job = k.CreateJobObjectW(None,None)
limits = EXTENDED_LIMIT()
limits.basic.flags = 0x2000
if not job or not k.SetInformationJobObject(job,9,c.byref(limits),c.sizeof(limits)):
    raise c.WinError(c.get_last_error())
name = 'KajiCheck_' + uuid.uuid4().hex
desktop = u.CreateDesktopW(name, None, None, 0, 0x01ff, None)
if not desktop:
    raise c.WinError(c.get_last_error())
info = STARTUPINFO()
info.cb = c.sizeof(info)
info.lpDesktop = 'winsta0\\' + name
process = PROCESS_INFORMATION()
try:
    command = c.create_unicode_buffer(subprocess.list2cmdline(sys.argv[1:]))
    if not k.CreateProcessW(sys.argv[1], command, None, None, False, 0x08000004, None, os.path.dirname(sys.argv[1]), c.byref(info), c.byref(process)):
        raise c.WinError(c.get_last_error())
    if not k.AssignProcessToJobObject(job,process.hProcess):
        raise c.WinError(c.get_last_error())
    k.ResumeThread(process.hThread)
    print(json.dumps({'pid': process.dwProcessId, 'desktop': name}), flush=True)
    sys.stdin.read(1)
finally:
    if process.hProcess:
        k.TerminateProcess(process.hProcess, 0)
        k.WaitForSingleObject(process.hProcess, 5000)
        k.CloseHandle(process.hThread)
        k.CloseHandle(process.hProcess)
    u.CloseDesktop(desktop)
    k.CloseHandle(job)
