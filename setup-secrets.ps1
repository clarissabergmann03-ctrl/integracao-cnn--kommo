Set-Location $PSScriptRoot

$secrets = @(
    @{ name = "KOMMO_ACCESS_TOKEN"; desc = "Token de longa duracao do Kommo (Keys and scopes > Generate long-lived token)" },
    @{ name = "WEBHOOK_SECRET";     desc = "String secreta para validar requisicoes ao Worker (voce inventa)" },
    @{ name = "CNN_CID";            desc = "Token da clinica (CNN > Configuracoes > Integracoes > API)" },
    @{ name = "CNN_BASIC_USER";     desc = "Client ID da API CNN" },
    @{ name = "CNN_BASIC_PASS";     desc = "Client Secret da API CNN" }
)

Write-Host ""
Write-Host "=== Configurar Secrets ===" -ForegroundColor Cyan
for ($i = 0; $i -lt $secrets.Count; $i++) {
    Write-Host "  [$($i+1)] $($secrets[$i].name)" -ForegroundColor Yellow
    Write-Host "      $($secrets[$i].desc)" -ForegroundColor Gray
}
Write-Host "  [0] Configurar todos" -ForegroundColor Green
Write-Host ""

$choice = Read-Host "Qual deseja configurar? (0-$($secrets.Count))"

function Set-Secret($s) {
    Write-Host ""
    Write-Host ">> $($s.name)" -ForegroundColor Cyan
    Write-Host "   $($s.desc)" -ForegroundColor Gray
    wrangler secret put $s.name
}

if ($choice -eq "0") {
    foreach ($s in $secrets) { Set-Secret $s }
} elseif ($choice -match "^\d+$" -and [int]$choice -ge 1 -and [int]$choice -le $secrets.Count) {
    Set-Secret $secrets[[int]$choice - 1]
} else {
    Write-Host "Opcao invalida." -ForegroundColor Red
    exit
}

Write-Host ""
Write-Host "=== Secrets na Cloudflare ===" -ForegroundColor Cyan
wrangler secret list
