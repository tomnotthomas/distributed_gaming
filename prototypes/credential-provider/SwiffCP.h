// Swiff credential provider - auto-submits a one-shot logon ticket at the sign-in screen.
//
// Safety contract, which the whole design hangs off: if there is no valid ticket, the provider
// reports ZERO credentials and sets no auto-logon. LogonUI then behaves exactly as if we were not
// installed. We never implement ICredentialProviderFilter, so the stock password tile is never
// hidden. A bug in here should degrade to "nothing happens", never to "cannot sign in".

#pragma once

#define WIN32_LEAN_AND_MEAN
#define SECURITY_WIN32
#include <windows.h>
#include <strsafe.h>
#include <credentialprovider.h>
#include <ntsecapi.h>
#include <wincred.h>
#include <security.h>   // NEGOSSP_NAME_A and the SSPI declarations
#include <new>

// {7A1F3C92-5D48-4B6E-A3C1-2F9E8D0B4A76}
extern const CLSID CLSID_SwiffProvider;

// Where the host service leaves the ticket. LogonUI runs as SYSTEM, so it can read HKLM.
#define SWIFF_TICKET_KEY    L"SOFTWARE\\Swiff\\Logon"
#define SWIFF_TICKET_VALUE  L"Ticket"

#define SWIFF_TICKET_VERSION 1
#define SWIFF_MAX_USER 64
#define SWIFF_MAX_PW  256

// The decrypted ticket. Written by the service, consumed exactly once by the provider.
#pragma pack(push, 1)
struct SwiffTicket {
    DWORD    dwVersion;
    FILETIME ftExpiry;              // UTC; a ticket past this is ignored
    WCHAR    wzUser[SWIFF_MAX_USER];  // local account name, no domain
    WCHAR    wzPassword[SWIFF_MAX_PW];
};
#pragma pack(pop)

// Reads, decrypts and validates the ticket, then DELETES the registry value so it can only ever
// be used once. Returns false when there is no usable ticket - the normal case.
bool SwiffTicketConsume(SwiffTicket* pOut);

// Zero memory the compiler is not allowed to optimise away.
void SwiffSecureZero(void* p, size_t cb);

long SwiffDllAddRef();
long SwiffDllRelease();

enum SWIFF_FIELD_ID {
    SFI_LABEL  = 0,
    SFI_SUBMIT = 1,
    SFI_NUM_FIELDS = 2,
};

HRESULT SwiffCredentialCreate(CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus,
                              const SwiffTicket& ticket,
                              ICredentialProviderCredential** ppCredential);

const CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR* SwiffFieldDescriptors();
