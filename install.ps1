[CmdletBinding(PositionalBinding=$false)]
param(
  [ValidateSet('Install','Uninstall')][string]$Mode='Install',
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
)
$ErrorActionPreference='Stop'
function Test-AgyNode($agyCandidate){
  if(-not $agyCandidate -or -not (Test-Path -LiteralPath $agyCandidate -PathType Leaf)){return $false}
  try{
    $ErrorActionPreference='Continue'
    $agyVersion=& $agyCandidate -p "process.versions.node" 2>$null
    if($LASTEXITCODE -ne 0 -or "$agyVersion" -notmatch '^\s*(\d+)\.(\d+)\.\d+\s*$'){return $false}
    return ([int]$Matches[1] -gt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 13))
  }catch{return $false}
}
$agyRuntime=$null
$agyCommand=Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if($agyCommand -and (Test-AgyNode $agyCommand.Source)){$agyRuntime=$agyCommand.Source}
if(-not $agyRuntime){
  $agyUserData=$env:ANTIGRAVITY_USER_DATA_DIR
  if(-not $agyUserData){
    $agyAppData=$env:APPDATA
    if(-not $agyAppData -and $env:USERPROFILE){$agyAppData=Join-Path $env:USERPROFILE 'AppData\Roaming'}
    if($agyAppData){$agyUserData=Join-Path $agyAppData 'Antigravity'}
  }
  if($agyUserData){
    $agyCandidate=Join-Path $agyUserData 'bin\agy-node.cmd'
    if(Test-AgyNode $agyCandidate){$agyRuntime=$agyCandidate}
  }
}
if(-not $agyRuntime){throw '未找到可用的 Node.js。请安装 Node.js 22.13 或更高版本，或先启动 Antigravity。'}
$agyScript=if($Mode -eq 'Uninstall'){'scripts/uninstall.mjs'}else{'scripts/install.mjs'}
& $agyRuntime (Join-Path $PSScriptRoot $agyScript) @Arguments
exit $LASTEXITCODE
