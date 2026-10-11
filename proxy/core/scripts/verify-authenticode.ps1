param(
  [Parameter(Mandatory = $true)]
  [string]$Artifact
)

$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $Artifact).Path
$signature = Get-AuthenticodeSignature -LiteralPath $resolved
$result = [ordered]@{
  status = $signature.Status.ToString()
  statusMessage = $signature.StatusMessage
  signerSubject = $signature.SignerCertificate.Subject
  signerThumbprint = $signature.SignerCertificate.Thumbprint
  signerNotAfter = if ($signature.SignerCertificate) { $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString("o") } else { $null }
  signerEnhancedKeyUsages = if ($signature.SignerCertificate) { @($signature.SignerCertificate.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId.Value }) } else { @() }
  timestampSubject = $signature.TimeStamperCertificate.Subject
  timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint
  timestampNotAfter = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.NotAfter.ToUniversalTime().ToString("o") } else { $null }
}
$result | ConvertTo-Json -Compress
