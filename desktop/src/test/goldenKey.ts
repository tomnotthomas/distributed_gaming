// The contract's golden-vector key: the RSA key that signs Lanterel OS's PCR 11
// policies in the seal's tests (tpm-seal.cjs), and an X.509 certificate for it,
// standing in for the image set's Secure Boot certificate. Its private half is
// nobody's, so the certificate was issued by a throwaway key:
//
//   openssl req -new -key throwaway.key -subj "/CN=Lanterel OS test Secure Boot" -out req.csr
//   openssl x509 -req -in req.csr -signkey throwaway.key -force_pubkey golden.pem -days 36500 -outform DER

export const GOLDEN_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuvd0rRC4ZFTuqGUvuwVw
qJ9AWGd0a4yYLc5eccopNbGTM3d2NaLVUwN/cbqXKCJNf8n1eerStT+zV95b/96V
6Mya30OigfUFJ7XneW12fJXvi1yl9YPeTdzR0QlGzSBIiY0BQPzUjdGymAwybxJo
xZ0k8D63DgFjPfAFG69wMzxurryzQo/MR2e4hhbJCO3OtmfVOY7j9mdLQ9+rOr5i
ST/FCBrNc+soy750lNH/ei8i7ExGOuTMnxTm8WcUi/09iDKAxemL5nFTQVGGlKKO
8KWeb/jQ7B4/3AUOOmseav5QjFVQi4bHHFuLeqBjQpB2hXhWsSXd/lP2KtQt4tgW
KwIDAQAB
-----END PUBLIC KEY-----
`;

export const GOLDEN_CERT = Buffer.from(
  "MIIC1zCCAb8CFDbqc92/zsMiuETt1WEykPr+QR31MA0GCSqGSIb3DQEBCwUAMCcxJTAjBgNVBAMMHExhbnRlcmVsIE9TIHRlc3QgU2VjdXJlIEJvb3QwIBcNMjYxMDEzMTM1MjI0WhgPMjEyNjA5MTkxMzUyMjRaMCcxJTAjBgNVBAMMHExhbnRlcmVsIE9TIHRlc3QgU2VjdXJlIEJvb3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC693StELhkVO6oZS+7BXCon0BYZ3RrjJgtzl5xyik1sZMzd3Y1otVTA39xupcoIk1/yfV56tK1P7NX3lv/3pXozJrfQ6KB9QUnted5bXZ8le+LXKX1g95N3NHRCUbNIEiJjQFA/NSN0bKYDDJvEmjFnSTwPrcOAWM98AUbr3AzPG6uvLNCj8xHZ7iGFskI7c62Z9U5juP2Z0tD36s6vmJJP8UIGs1z6yjLvnSU0f96LyLsTEY65MyfFObxZxSL/T2IMoDF6YvmcVNBUYaUoo7wpZ5v+NDsHj/cBQ46ax5q/lCMVVCLhsccW4t6oGNCkHaFeFaxJd3+U/Yq1C3i2BYrAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAJZ7kvx5qMP0rit4rYYd8msfsH8t/XDDci+ndzzUXWzgoDZfedA69gpomL1A5SczRn2D55kC+30FOQwWqrSZdsUdcyTwOWmg3PGxEocHkfwvowJo72izK/XDndi0O05Z9Hf56+oDGCcibt75OEnI2C+hnoAMTFlzcV+IwfaIsAIJ/BgPa4c60Yf3uLEY0YJmzhIwVAuuUHnQNq7g3xYLHp9e9cMVcecFxhdVO4frUXp9bIN7Y/TqF5zZjVPs2xMZ/Y82sTCEtjN+5pm6aLSHL3Qd5kchcrpgMAvzJoOGIexKiRBkgwP9WYA88OAt14O60irRJYrQjWZWTPqNPU3jOKc=",
  "base64",
);
