// The credential tile. It has no input fields - it exists only to hand LogonUI a serialized
// KERB_INTERACTIVE_UNLOCK_LOGON built from the ticket, the moment LogonUI asks for one.

#include "SwiffCP.h"

#pragma comment(lib, "Secur32.lib")
#pragma comment(lib, "Ole32.lib")

static const CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR s_fieldDescriptors[SFI_NUM_FIELDS] = {
    { SFI_LABEL,  CPFT_LARGE_TEXT,    const_cast<PWSTR>(L"Swiff session") },
    { SFI_SUBMIT, CPFT_SUBMIT_BUTTON, const_cast<PWSTR>(L"Start") },
};

static const CREDENTIAL_PROVIDER_FIELD_STATE s_fieldStates[SFI_NUM_FIELDS] = {
    CPFS_DISPLAY_IN_BOTH,
    CPFS_DISPLAY_IN_SELECTED_TILE,
};

static HRESULT DupString(PCWSTR pwz, PWSTR* ppwz)
{
    if (!pwz) { *ppwz = nullptr; return E_INVALIDARG; }
    size_t cb = (wcslen(pwz) + 1) * sizeof(WCHAR);
    *ppwz = static_cast<PWSTR>(CoTaskMemAlloc(cb));
    if (!*ppwz) return E_OUTOFMEMORY;
    memcpy(*ppwz, pwz, cb);
    return S_OK;
}

// ---------------------------------------------------------------- LSA plumbing
static void UnicodeStringInitWithString(PWSTR pwz, UNICODE_STRING* pus)
{
    if (pwz) {
        size_t lch = wcslen(pwz);
        pus->Length        = static_cast<USHORT>(lch * sizeof(WCHAR));
        pus->MaximumLength = static_cast<USHORT>((lch + 1) * sizeof(WCHAR));
        pus->Buffer        = pwz;
    } else {
        ZeroMemory(pus, sizeof(*pus));
    }
}

static HRESULT KerbInteractiveUnlockLogonInit(PWSTR pwzDomain, PWSTR pwzUser, PWSTR pwzPassword,
                                              CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus,
                                              KERB_INTERACTIVE_UNLOCK_LOGON* pkiul)
{
    KERB_INTERACTIVE_UNLOCK_LOGON kiul;
    ZeroMemory(&kiul, sizeof(kiul));
    KERB_INTERACTIVE_LOGON* pkil = &kiul.Logon;

    UnicodeStringInitWithString(pwzDomain,   &pkil->LogonDomainName);
    UnicodeStringInitWithString(pwzUser,     &pkil->UserName);
    UnicodeStringInitWithString(pwzPassword, &pkil->Password);

    switch (cpus) {
    case CPUS_UNLOCK_WORKSTATION: pkil->MessageType = KerbWorkstationUnlockLogon; break;
    case CPUS_LOGON:              pkil->MessageType = KerbInteractiveLogon;       break;
    default:                      return E_INVALIDARG;
    }

    *pkiul = kiul;
    return S_OK;
}

static void PackedUnicodeStringCopy(const UNICODE_STRING& rus, PWSTR pwzBuffer, UNICODE_STRING* pus)
{
    pus->Length        = rus.Length;
    pus->MaximumLength = rus.Length;
    pus->Buffer        = pwzBuffer;
    if (rus.Length) {
        CopyMemory(pus->Buffer, rus.Buffer, rus.Length);
    }
}

// LSA wants the strings packed after the struct with Buffer holding a byte OFFSET, not a pointer.
static HRESULT KerbInteractiveUnlockLogonPack(const KERB_INTERACTIVE_UNLOCK_LOGON& rkiulIn,
                                              BYTE** prgb, DWORD* pcb)
{
    const KERB_INTERACTIVE_LOGON* pkilIn = &rkiulIn.Logon;

    const DWORD cb = sizeof(rkiulIn)
                   + pkilIn->LogonDomainName.Length
                   + pkilIn->UserName.Length
                   + pkilIn->Password.Length;

    KERB_INTERACTIVE_UNLOCK_LOGON* pkiulOut =
        static_cast<KERB_INTERACTIVE_UNLOCK_LOGON*>(CoTaskMemAlloc(cb));
    if (!pkiulOut) return E_OUTOFMEMORY;

    ZeroMemory(&pkiulOut->LogonId, sizeof(LUID));

    BYTE* pbBuffer = reinterpret_cast<BYTE*>(pkiulOut) + sizeof(*pkiulOut);
    KERB_INTERACTIVE_LOGON* pkilOut = &pkiulOut->Logon;
    pkilOut->MessageType = pkilIn->MessageType;

    PackedUnicodeStringCopy(pkilIn->LogonDomainName, reinterpret_cast<PWSTR>(pbBuffer), &pkilOut->LogonDomainName);
    pkilOut->LogonDomainName.Buffer = reinterpret_cast<PWSTR>(pbBuffer - reinterpret_cast<BYTE*>(pkiulOut));
    pbBuffer += pkilOut->LogonDomainName.Length;

    PackedUnicodeStringCopy(pkilIn->UserName, reinterpret_cast<PWSTR>(pbBuffer), &pkilOut->UserName);
    pkilOut->UserName.Buffer = reinterpret_cast<PWSTR>(pbBuffer - reinterpret_cast<BYTE*>(pkiulOut));
    pbBuffer += pkilOut->UserName.Length;

    PackedUnicodeStringCopy(pkilIn->Password, reinterpret_cast<PWSTR>(pbBuffer), &pkilOut->Password);
    pkilOut->Password.Buffer = reinterpret_cast<PWSTR>(pbBuffer - reinterpret_cast<BYTE*>(pkiulOut));

    *prgb = reinterpret_cast<BYTE*>(pkiulOut);
    *pcb  = cb;
    return S_OK;
}

static HRESULT RetrieveNegotiateAuthPackage(ULONG* pulAuthPackage)
{
    HANDLE hLsa = nullptr;
    NTSTATUS status = LsaConnectUntrusted(&hLsa);
    if (status != 0) return HRESULT_FROM_WIN32(LsaNtStatusToWinError(status));

    ULONG ulAuthPackage = 0;
    LSA_STRING name;
    name.Buffer        = const_cast<PCHAR>(NEGOSSP_NAME_A);
    name.Length        = static_cast<USHORT>(strlen(NEGOSSP_NAME_A));
    name.MaximumLength = static_cast<USHORT>(name.Length + 1);

    status = LsaLookupAuthenticationPackage(hLsa, &name, &ulAuthPackage);
    LsaDeregisterLogonProcess(hLsa);

    if (status != 0) return HRESULT_FROM_WIN32(LsaNtStatusToWinError(status));
    *pulAuthPackage = ulAuthPackage;
    return S_OK;
}

// ---------------------------------------------------------------- the credential
class CSwiffCredential : public ICredentialProviderCredential
{
public:
    CSwiffCredential(CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus, const SwiffTicket& ticket)
        : _cRef(1), _cpus(cpus), _pEvents(nullptr)
    {
        memcpy(&_ticket, &ticket, sizeof(_ticket));
        SwiffDllAddRef();
    }

    // IUnknown
    IFACEMETHODIMP_(ULONG) AddRef()  { return InterlockedIncrement(&_cRef); }
    IFACEMETHODIMP_(ULONG) Release()
    {
        LONG c = InterlockedDecrement(&_cRef);
        if (!c) delete this;
        return c;
    }
    IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv)
    {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICredentialProviderCredential) {
            *ppv = static_cast<ICredentialProviderCredential*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    IFACEMETHODIMP Advise(ICredentialProviderCredentialEvents* pcpce)
    {
        if (_pEvents) _pEvents->Release();
        _pEvents = pcpce;
        if (_pEvents) _pEvents->AddRef();
        return S_OK;
    }
    IFACEMETHODIMP UnAdvise()
    {
        if (_pEvents) { _pEvents->Release(); _pEvents = nullptr; }
        return S_OK;
    }

    // Selecting the tile is itself a request to log on - belt and braces alongside the
    // pbAutoLogonWithDefault the provider returns.
    IFACEMETHODIMP SetSelected(BOOL* pbAutoLogon) { *pbAutoLogon = TRUE; return S_OK; }
    IFACEMETHODIMP SetDeselected() { return S_OK; }

    IFACEMETHODIMP GetFieldState(DWORD dwFieldID,
                                 CREDENTIAL_PROVIDER_FIELD_STATE* pcpfs,
                                 CREDENTIAL_PROVIDER_FIELD_INTERACTIVE_STATE* pcpfis)
    {
        if (dwFieldID >= SFI_NUM_FIELDS) return E_INVALIDARG;
        *pcpfs  = s_fieldStates[dwFieldID];
        *pcpfis = CPFIS_NONE;
        return S_OK;
    }

    IFACEMETHODIMP GetStringValue(DWORD dwFieldID, PWSTR* ppwz)
    {
        if (dwFieldID >= SFI_NUM_FIELDS) return E_INVALIDARG;
        return DupString(s_fieldDescriptors[dwFieldID].pszLabel, ppwz);
    }

    IFACEMETHODIMP GetBitmapValue(DWORD, HBITMAP*)                  { return E_NOTIMPL; }
    IFACEMETHODIMP GetCheckboxValue(DWORD, BOOL*, PWSTR*)           { return E_NOTIMPL; }
    IFACEMETHODIMP GetComboBoxValueCount(DWORD, DWORD*, DWORD*)     { return E_NOTIMPL; }
    IFACEMETHODIMP GetComboBoxValueAt(DWORD, DWORD, PWSTR*)         { return E_NOTIMPL; }
    IFACEMETHODIMP SetStringValue(DWORD, PCWSTR)                    { return E_NOTIMPL; }
    IFACEMETHODIMP SetCheckboxValue(DWORD, BOOL)                    { return E_NOTIMPL; }
    IFACEMETHODIMP SetComboBoxSelectedValue(DWORD, DWORD)           { return E_NOTIMPL; }
    IFACEMETHODIMP CommandLinkClicked(DWORD)                        { return E_NOTIMPL; }

    IFACEMETHODIMP GetSubmitButtonValue(DWORD dwFieldID, DWORD* pdwAdjacentTo)
    {
        if (dwFieldID != SFI_SUBMIT) return E_INVALIDARG;
        *pdwAdjacentTo = SFI_LABEL;
        return S_OK;
    }

    IFACEMETHODIMP GetSerialization(CREDENTIAL_PROVIDER_GET_SERIALIZATION_RESPONSE* pcpgsr,
                                    CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION* pcpcs,
                                    PWSTR* ppwzOptionalStatusText,
                                    CREDENTIAL_PROVIDER_STATUS_ICON* pcpsiOptionalStatusIcon)
    {
        *ppwzOptionalStatusText   = nullptr;
        *pcpsiOptionalStatusIcon  = CPSI_NONE;
        *pcpgsr                   = CPGSR_NO_CREDENTIAL_NOT_FINISHED;

        // A local account authenticates against the machine name as its "domain".
        WCHAR wzComputer[MAX_COMPUTERNAME_LENGTH + 1] = {};
        DWORD cchComputer = ARRAYSIZE(wzComputer);
        if (!GetComputerNameW(wzComputer, &cchComputer)) return HRESULT_FROM_WIN32(GetLastError());

        KERB_INTERACTIVE_UNLOCK_LOGON kiul;
        HRESULT hr = KerbInteractiveUnlockLogonInit(wzComputer, _ticket.wzUser, _ticket.wzPassword, _cpus, &kiul);
        if (FAILED(hr)) return hr;

        hr = KerbInteractiveUnlockLogonPack(kiul, &pcpcs->rgbSerialization, &pcpcs->cbSerialization);
        SwiffSecureZero(&kiul, sizeof(kiul));
        if (FAILED(hr)) return hr;

        ULONG ulAuthPackage = 0;
        hr = RetrieveNegotiateAuthPackage(&ulAuthPackage);
        if (FAILED(hr)) {
            SwiffSecureZero(pcpcs->rgbSerialization, pcpcs->cbSerialization);
            CoTaskMemFree(pcpcs->rgbSerialization);
            pcpcs->rgbSerialization = nullptr;
            pcpcs->cbSerialization  = 0;
            return hr;
        }

        pcpcs->ulAuthenticationPackage = ulAuthPackage;
        pcpcs->clsidCredentialProvider = CLSID_SwiffProvider;
        *pcpgsr = CPGSR_RETURN_CREDENTIAL_FINISHED;

        // The password has been handed over; do not keep our copy alive any longer.
        SwiffSecureZero(_ticket.wzPassword, sizeof(_ticket.wzPassword));
        return S_OK;
    }

    IFACEMETHODIMP ReportResult(NTSTATUS, NTSTATUS, PWSTR* ppwzOptionalStatusText,
                                CREDENTIAL_PROVIDER_STATUS_ICON* pcpsiOptionalStatusIcon)
    {
        *ppwzOptionalStatusText  = nullptr;
        *pcpsiOptionalStatusIcon = CPSI_NONE;
        return S_OK;
    }

private:
    ~CSwiffCredential()
    {
        if (_pEvents) _pEvents->Release();
        SwiffSecureZero(&_ticket, sizeof(_ticket));
        SwiffDllRelease();
    }

    LONG                                    _cRef;
    CREDENTIAL_PROVIDER_USAGE_SCENARIO      _cpus;
    ICredentialProviderCredentialEvents*    _pEvents;
    SwiffTicket                             _ticket;
};

HRESULT SwiffCredentialCreate(CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus,
                              const SwiffTicket& ticket,
                              ICredentialProviderCredential** ppCredential)
{
    *ppCredential = nullptr;
    CSwiffCredential* p = new (std::nothrow) CSwiffCredential(cpus, ticket);
    if (!p) return E_OUTOFMEMORY;
    *ppCredential = p;
    return S_OK;
}

const CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR* SwiffFieldDescriptors() { return s_fieldDescriptors; }
