// ICredentialProvider plus the COM plumbing.
//
// The only interesting decision is in GetCredentialCount: with no ticket we report zero
// credentials and no auto-logon, which makes the provider invisible and leaves the sign-in
// screen exactly as it was.

#include "SwiffCP.h"

// {7A1F3C92-5D48-4B6E-A3C1-2F9E8D0B4A76}
const CLSID CLSID_SwiffProvider =
    { 0x7a1f3c92, 0x5d48, 0x4b6e, { 0xa3, 0xc1, 0x2f, 0x9e, 0x8d, 0x0b, 0x4a, 0x76 } };

static HINSTANCE g_hInst = nullptr;
static LONG      g_cDllRef = 0;

long SwiffDllAddRef()  { return InterlockedIncrement(&g_cDllRef); }
long SwiffDllRelease() { return InterlockedDecrement(&g_cDllRef); }

static HRESULT DupString(PCWSTR pwz, PWSTR* ppwz)
{
    if (!pwz) { *ppwz = nullptr; return E_INVALIDARG; }
    size_t cb = (wcslen(pwz) + 1) * sizeof(WCHAR);
    *ppwz = static_cast<PWSTR>(CoTaskMemAlloc(cb));
    if (!*ppwz) return E_OUTOFMEMORY;
    memcpy(*ppwz, pwz, cb);
    return S_OK;
}

class CSwiffProvider : public ICredentialProvider
{
public:
    CSwiffProvider() : _cRef(1), _cpus(CPUS_INVALID), _pCredential(nullptr), _fHaveTicket(false)
    {
        ZeroMemory(&_ticket, sizeof(_ticket));
        SwiffDllAddRef();
    }

    IFACEMETHODIMP_(ULONG) AddRef() { return InterlockedIncrement(&_cRef); }
    IFACEMETHODIMP_(ULONG) Release()
    {
        LONG c = InterlockedDecrement(&_cRef);
        if (!c) delete this;
        return c;
    }
    IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv)
    {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_ICredentialProvider) {
            *ppv = static_cast<ICredentialProvider*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    IFACEMETHODIMP SetUsageScenario(CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus, DWORD /*dwFlags*/)
    {
        // Only the two scenarios that can create or restore a session. Everything else - CredUI,
        // password change - is none of our business, and E_NOTIMPL keeps us out of it entirely.
        if (cpus != CPUS_LOGON && cpus != CPUS_UNLOCK_WORKSTATION) {
            return E_NOTIMPL;
        }
        _cpus = cpus;

        if (!_fHaveTicket) {
            _fHaveTicket = SwiffTicketConsume(&_ticket);   // one shot; deletes the value
        }
        if (_fHaveTicket && !_pCredential) {
            if (FAILED(SwiffCredentialCreate(_cpus, _ticket, &_pCredential))) {
                _pCredential = nullptr;
                _fHaveTicket = false;
            }
            // The credential owns its own copy now.
            SwiffSecureZero(_ticket.wzPassword, sizeof(_ticket.wzPassword));
        }
        return S_OK;
    }

    IFACEMETHODIMP SetSerialization(const CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION*)
    {
        return E_NOTIMPL;
    }

    IFACEMETHODIMP Advise(ICredentialProviderEvents*, UINT_PTR) { return S_OK; }
    IFACEMETHODIMP UnAdvise()                                   { return S_OK; }

    IFACEMETHODIMP GetFieldDescriptorCount(DWORD* pdwCount)
    {
        *pdwCount = SFI_NUM_FIELDS;
        return S_OK;
    }

    IFACEMETHODIMP GetFieldDescriptorAt(DWORD dwIndex,
                                        CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR** ppcpfd)
    {
        *ppcpfd = nullptr;
        if (dwIndex >= SFI_NUM_FIELDS) return E_INVALIDARG;

        CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR* p =
            static_cast<CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR*>(
                CoTaskMemAlloc(sizeof(CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR)));
        if (!p) return E_OUTOFMEMORY;

        const CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR& src = SwiffFieldDescriptors()[dwIndex];
        p->dwFieldID = src.dwFieldID;
        p->cpft      = src.cpft;
        p->guidFieldType = src.guidFieldType;

        HRESULT hr = DupString(src.pszLabel, &p->pszLabel);
        if (FAILED(hr)) { CoTaskMemFree(p); return hr; }

        *ppcpfd = p;
        return S_OK;
    }

    IFACEMETHODIMP GetCredentialCount(DWORD* pdwCount, DWORD* pdwDefault,
                                      BOOL* pbAutoLogonWithDefault)
    {
        if (_fHaveTicket && _pCredential) {
            *pdwCount = 1;
            *pdwDefault = 0;
            *pbAutoLogonWithDefault = TRUE;    // LogonUI submits immediately, no interaction
        } else {
            // Invisible. This is the path taken at every ordinary sign-in.
            *pdwCount = 0;
            *pdwDefault = CREDENTIAL_PROVIDER_NO_DEFAULT;
            *pbAutoLogonWithDefault = FALSE;
        }
        return S_OK;
    }

    IFACEMETHODIMP GetCredentialAt(DWORD dwIndex, ICredentialProviderCredential** ppcpc)
    {
        *ppcpc = nullptr;
        if (dwIndex != 0 || !_pCredential) return E_INVALIDARG;
        return _pCredential->QueryInterface(IID_ICredentialProviderCredential,
                                            reinterpret_cast<void**>(ppcpc));
    }

private:
    ~CSwiffProvider()
    {
        if (_pCredential) _pCredential->Release();
        SwiffSecureZero(&_ticket, sizeof(_ticket));
        SwiffDllRelease();
    }

    LONG                                _cRef;
    CREDENTIAL_PROVIDER_USAGE_SCENARIO  _cpus;
    ICredentialProviderCredential*      _pCredential;
    SwiffTicket                         _ticket;
    bool                                _fHaveTicket;
};

// ---------------------------------------------------------------- class factory
class CSwiffFactory : public IClassFactory
{
public:
    CSwiffFactory() : _cRef(1) { SwiffDllAddRef(); }

    IFACEMETHODIMP_(ULONG) AddRef() { return InterlockedIncrement(&_cRef); }
    IFACEMETHODIMP_(ULONG) Release()
    {
        LONG c = InterlockedDecrement(&_cRef);
        if (!c) delete this;
        return c;
    }
    IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv)
    {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IClassFactory) {
            *ppv = static_cast<IClassFactory*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    IFACEMETHODIMP CreateInstance(IUnknown* pUnkOuter, REFIID riid, void** ppv)
    {
        *ppv = nullptr;
        if (pUnkOuter) return CLASS_E_NOAGGREGATION;

        CSwiffProvider* p = new (std::nothrow) CSwiffProvider();
        if (!p) return E_OUTOFMEMORY;

        HRESULT hr = p->QueryInterface(riid, ppv);
        p->Release();
        return hr;
    }

    IFACEMETHODIMP LockServer(BOOL fLock)
    {
        if (fLock) SwiffDllAddRef(); else SwiffDllRelease();
        return S_OK;
    }

private:
    ~CSwiffFactory() { SwiffDllRelease(); }
    LONG _cRef;
};

// ---------------------------------------------------------------- exports
STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv)
{
    *ppv = nullptr;
    if (rclsid != CLSID_SwiffProvider) return CLASS_E_CLASSNOTAVAILABLE;

    CSwiffFactory* pFactory = new (std::nothrow) CSwiffFactory();
    if (!pFactory) return E_OUTOFMEMORY;

    HRESULT hr = pFactory->QueryInterface(riid, ppv);
    pFactory->Release();
    return hr;
}

STDAPI DllCanUnloadNow()
{
    return (g_cDllRef > 0) ? S_FALSE : S_OK;
}

BOOL APIENTRY DllMain(HINSTANCE hInst, DWORD dwReason, LPVOID)
{
    if (dwReason == DLL_PROCESS_ATTACH) {
        g_hInst = hInst;
        DisableThreadLibraryCalls(hInst);
    }
    return TRUE;
}
