$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $env:LOCALAPPDATA 'PSEAgent\lunkr-runtime'
$serviceLogPath = Join-Path $runtimeDirectory 'lunkr-service.log'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$serviceMutex = New-Object System.Threading.Mutex($false, 'Local\PSEAgent.Lunkr.Service')
$lockAcquired = $false

New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Set-Location -LiteralPath $repositoryRoot

try {
  try {
    $lockAcquired = $serviceMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $lockAcquired = $true
  }
  if (-not $lockAcquired) { exit 0 }

  $restartDelaySeconds = 5
  while ($true) {
    $startedAt = [DateTime]::UtcNow
    $runStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $standardOutputPath = Join-Path $runtimeDirectory "lunkr-$runStamp.stdout.log"
    $standardErrorPath = Join-Path $runtimeDirectory "lunkr-$runStamp.stderr.log"
    Add-Content -LiteralPath $serviceLogPath -Encoding UTF8 -Value "pseagent.lunkr.service.starting at=$($startedAt.ToString('O')) stderr=$standardErrorPath"

    try {
      $process = Start-Process -FilePath $nodeExecutable `
        -ArgumentList @('--env-file=.env.local', '--import', 'tsx', 'scripts/lunkr-start.mts') `
        -WorkingDirectory $repositoryRoot -WindowStyle Hidden `
        -RedirectStandardOutput $standardOutputPath `
        -RedirectStandardError $standardErrorPath -Wait -PassThru
      $exitCode = $process.ExitCode
    } catch {
      $exitCode = 1
      Add-Content -LiteralPath $serviceLogPath -Encoding UTF8 -Value 'pseagent.lunkr.service.launch_failed'
    }

    $stoppedAt = [DateTime]::UtcNow
    Add-Content -LiteralPath $serviceLogPath -Encoding UTF8 -Value "pseagent.lunkr.service.stopped at=$($stoppedAt.ToString('O')) exitCode=$exitCode restartInSeconds=$restartDelaySeconds"
    Start-Sleep -Seconds $restartDelaySeconds

    if (($stoppedAt - $startedAt).TotalMinutes -ge 5) {
      $restartDelaySeconds = 5
    } else {
      $restartDelaySeconds = [Math]::Min(60, $restartDelaySeconds * 2)
    }
  }
} finally {
  if ($lockAcquired) { $serviceMutex.ReleaseMutex() }
  $serviceMutex.Dispose()
}
