// Ticket storage: DPAPI machine-scope blob in HKLM, consumed exactly once.
//
// Machine scope (CRYPTPROTECT_LOCAL_MACHINE) is deliberate: LogonUI runs as SYSTEM with no user
// profile loaded, so a user-scope blob could not be decrypted there. The protection that matters
// is the registry ACL (SYSTEM + Administrators only) plus the one-shot delete and the expiry.

#include "SwiffCP.h"
#include <wincrypt.h>

#pragma comment(lib, "Crypt32.lib")
#pragma comment(lib, "Advapi32.lib")

void SwiffSecureZero(void* p, size_t cb)
{
    if (p && cb) {
        SecureZeroMemory(p, cb);
    }
}

static bool TicketExpired(const FILETIME& ft)
{
    FILETIME now;
    GetSystemTimeAsFileTime(&now);
    ULARGE_INTEGER a, b;
    a.LowPart = now.dwLowDateTime;  a.HighPart = now.dwHighDateTime;
    b.LowPart = ft.dwLowDateTime;   b.HighPart = ft.dwHighDateTime;
    return a.QuadPart > b.QuadPart;
}

bool SwiffTicketConsume(SwiffTicket* pOut)
{
    if (!pOut) {
        return false;
    }
    ZeroMemory(pOut, sizeof(*pOut));

    HKEY hKey = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, SWIFF_TICKET_KEY, 0,
                      KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY, &hKey) != ERROR_SUCCESS) {
        return false;                       // not installed / nothing pending - the normal path
    }

    bool ok = false;
    BYTE* pbBlob = nullptr;

    DWORD cbBlob = 0, dwType = 0;
    if (RegQueryValueExW(hKey, SWIFF_TICKET_VALUE, nullptr, &dwType, nullptr, &cbBlob) == ERROR_SUCCESS &&
        dwType == REG_BINARY && cbBlob > 0 && cbBlob < 64 * 1024) {

        pbBlob = (BYTE*)LocalAlloc(LPTR, cbBlob);
        if (pbBlob &&
            RegQueryValueExW(hKey, SWIFF_TICKET_VALUE, nullptr, &dwType, pbBlob, &cbBlob) == ERROR_SUCCESS) {

            DATA_BLOB in, out;
            in.pbData = pbBlob;
            in.cbData = cbBlob;
            ZeroMemory(&out, sizeof(out));

            if (CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr, 0, &out)) {
                if (out.cbData == sizeof(SwiffTicket)) {
                    SwiffTicket* pT = (SwiffTicket*)out.pbData;
                    if (pT->dwVersion == SWIFF_TICKET_VERSION && !TicketExpired(pT->ftExpiry)) {
                        // Make sure the strings are terminated before anyone uses them.
                        pT->wzUser[SWIFF_MAX_USER - 1] = L'\0';
                        pT->wzPassword[SWIFF_MAX_PW - 1] = L'\0';
                        if (pT->wzUser[0] != L'\0') {
                            memcpy(pOut, pT, sizeof(SwiffTicket));
                            ok = true;
                        }
                    }
                }
                SwiffSecureZero(out.pbData, out.cbData);
                LocalFree(out.pbData);
            }
        }
    }

    // One shot: delete the value whether or not it parsed, so a malformed or expired ticket
    // cannot sit around being retried at every sign-in.
    RegDeleteValueW(hKey, SWIFF_TICKET_VALUE);
    RegCloseKey(hKey);

    if (pbBlob) {
        SwiffSecureZero(pbBlob, cbBlob);
        LocalFree(pbBlob);
    }
    return ok;
}
