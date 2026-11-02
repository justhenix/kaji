param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AgentArguments)
$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path $env:LOCALAPPDATA 'Kaji/gateway-token.dpapi'
if (-not (Test-Path -LiteralPath $credentialPath)) { throw 'Provision the Windows user credential described in gateway/README.md first.' }
$secureToken = ConvertTo-SecureString -String (Get-Content -LiteralPath $credentialPath -Raw).Trim()
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$previousToken = $env:KAJI_GATEWAY_TOKEN
try {
    $env:KAJI_GATEWAY_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    & bun (Join-Path $PSScriptRoot '../agent/cli.ts') --gateway @AgentArguments
    $agentExitCode = $LASTEXITCODE
} finally {
    if ($null -eq $previousToken) { Remove-Item Env:KAJI_GATEWAY_TOKEN -ErrorAction SilentlyContinue } else { $env:KAJI_GATEWAY_TOKEN = $previousToken }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    $secureToken.Dispose()
}
exit $agentExitCode
