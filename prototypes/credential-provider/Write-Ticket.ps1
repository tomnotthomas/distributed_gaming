# Writes the one-shot logon ticket the provider consumes. Must run elevated.
#
# Layout must match `struct SwiffTicket` in SwiffCP.h exactly (#pragma pack(1)):
#   DWORD    dwVersion      4
#   FILETIME ftExpiry       8
#   WCHAR    wzUser[64]    128
#   WCHAR    wzPassword[256] 512
#                        = 652 bytes
#
# Encrypted with DPAPI machine scope, because LogonUI runs as SYSTEM with no user profile loaded
# and could not decrypt a user-scope blob.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$UserName,
  [Parameter(Mandatory = $true)][string]$Password,
  [int]$ValidSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$MAX_USER = 64
$MAX_PW   = 256
$SIZE     = 4 + 8 + ($MAX_USER * 2) + ($MAX_PW * 2)

if ($UserName.Length -ge $MAX_USER) { throw "user name too long (max $($MAX_USER - 1))" }
if ($Password.Length -ge $MAX_PW)   { throw "password too long (max $($MAX_PW - 1))" }

Add-Type -AssemblyName System.Security

$buf = New-Object byte[] $SIZE
$ms  = New-Object IO.MemoryStream(, $buf)
$bw  = New-Object IO.BinaryWriter($ms, [Text.Encoding]::Unicode)

$bw.Write([uint32]1)                                            # dwVersion
$bw.Write([int64]((Get-Date).ToUniversalTime().AddSeconds($ValidSeconds).ToFileTimeUtc()))  # ftExpiry

# Fixed-width, NUL-padded UTF-16LE.
function Write-Fixed { param([IO.BinaryWriter]$W, [string]$S, [int]$Chars)
  $b = [Text.Encoding]::Unicode.GetBytes($S)
  $W.Write($b)
  $W.Write((New-Object byte[] (($Chars * 2) - $b.Length)))
}
Write-Fixed $bw $UserName $MAX_USER
Write-Fixed $bw $Password $MAX_PW
$bw.Flush()

if ($ms.Position -ne $SIZE) { throw "ticket is $($ms.Position) bytes, expected $SIZE" }

$enc = [Security.Cryptography.ProtectedData]::Protect(
         $buf, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)

# Wipe the plaintext copy we just built.
[Array]::Clear($buf, 0, $buf.Length)
$bw.Dispose(); $ms.Dispose()

$key = 'HKLM:\SOFTWARE\Swiff\Logon'
if (-not (Test-Path $key)) { throw "$key missing - run Register-Provider.ps1 first" }
Set-ItemProperty -Path $key -Name 'Ticket' -Value $enc -Type Binary

Write-Host ("ticket written for '{0}', {1} bytes encrypted, valid until {2}" -f `
  $UserName, $enc.Length, (Get-Date).AddSeconds($ValidSeconds).ToString('HH:mm:ss'))
