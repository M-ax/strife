// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <windows.h>
#include <cstdint>

// PID alone is not an identity: a closed application's PID can be reused.
inline uint64_t processCreation(DWORD pid)
{
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (!process) return 0;
    FILETIME created{}, exited{}, kernel{}, user{};
    const bool live = WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
        GetProcessTimes(process, &created, &exited, &kernel, &user);
    CloseHandle(process);
    return live ? (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime : 0;
}
inline bool sameWindow(HWND window, DWORD pid, uint64_t created)
{
    DWORD current = 0;
    return window && created && IsWindow(window) && GetWindowThreadProcessId(window, &current) &&
        current == pid && processCreation(pid) == created;
}
