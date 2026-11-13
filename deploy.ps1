# Gifted Gifter — backend deploy (Windows PowerShell or pwsh).
# The website deploys itself: push to main and Amplify rebuilds it (amplify.yml).
#   .\deploy.ps1              CloudFormation (Cognito, DynamoDB, S3, APIs, Lambda) + Lambda code + site\config.js
#   .\deploy.ps1 -CodeOnly    just the Lambda code
#   .\deploy.ps1 -AmplifyOrigin https://main.d123abc.amplifyapp.com   also allow sign-in on the Amplify URL
param(
  [string]$AwsProfile = 'prismcortex',
  [string]$Region = 'us-east-1',
  [string]$Stack = 'gifted-gifter',
  [string]$Domain = 'giftedgifter.prismcortex.net',
  [string]$AmplifyOrigin = '',
  [switch]$CodeOnly
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Invoke-Aws {
  $out = & aws @args --profile $AwsProfile --region $Region
  if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') failed (exit $LASTEXITCODE)" }
  return ($out -join "`n")
}
function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

if (-not $CodeOnly) {
  Step 'CloudFormation (Cognito, DynamoDB, S3, Lambda, APIs)'
  & aws cloudformation deploy --template-file infra/template.yaml --stack-name $Stack `
    --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset `
    --parameter-overrides "AppDomain=$Domain" "AmplifyOrigin=$AmplifyOrigin" --profile $AwsProfile --region $Region
  if ($LASTEXITCODE -ne 0) { throw 'CloudFormation deploy failed - see the stack events in the AWS console' }
}

$outputs = @{}
(Invoke-Aws cloudformation describe-stacks --stack-name $Stack --query 'Stacks[0].Outputs' --output json | ConvertFrom-Json) |
  ForEach-Object { $outputs[$_.OutputKey] = $_.OutputValue }

Step 'Lambda code'
$zip = Join-Path $env:TEMP 'gifted-gifter-api.zip'
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path backend\*.mjs -DestinationPath $zip
Invoke-Aws lambda update-function-code --function-name $outputs.FunctionName --zip-file "fileb://$zip" | Out-Null
Invoke-Aws lambda wait function-updated --function-name $outputs.FunctionName | Out-Null
Write-Host "Updated $($outputs.FunctionName)"

Step 'site\config.js'
$config = @"
// Written by deploy.ps1. These are public IDs (no secrets), so this file is committed.
window.GG_CONFIG = {
  api: '$($outputs.ApiUrl)',
  ws: '$($outputs.WsUrl)',
  authDomain: '$($outputs.AuthDomain)',
  clientId: '$($outputs.ClientId)',
};
"@
$old = if (Test-Path site\config.js) { Get-Content site\config.js -Raw } else { '' }
$config | Set-Content -Encoding UTF8 site\config.js
if ($old.Trim() -ne $config.Trim()) {
  Write-Host 'config.js changed - commit and push it so the live site picks it up:' -ForegroundColor Yellow
  Write-Host '  git add site/config.js; git commit -m "Update config"; git push'
} else { Write-Host 'config.js unchanged' }

Step 'Done'
