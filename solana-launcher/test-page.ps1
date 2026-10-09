# Test script to verify X Collector tab functionality
Write-Host "=== Testing X Collector Integration ===" -ForegroundColor Cyan

# Define URL
$url = "http://localhost:3000/settings"

# Fetch the page
try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing
    Write-Host "Status: $($response.StatusCode) - $url" -ForegroundColor Green
    
    # Check for key elements
    $html = $response.Content
    
    $checks = @{
        "X Collector tab" = "X Collector"
        "Fetch summary script" = '"/api/integrations/x-collector"'
        "Process cards" = "ProcessCard"
        "Module buttons" = "Аккаунты"
        "Module click handler" = "handleModuleClick"
        "Section IDs" = "id=""overview"""
    }
    
    Write-Host "`n=== Page Content Checks ===" -ForegroundColor Yellow
    foreach ($key in $checks.Keys) {
        $found = $html -match $checks[$key]
        $status = if ($found) { "✓ FOUND" } else { "✗ MISSING" }
        $color = if ($found) { "Green" } else { "Red" }
        Write-Host "$key : $status" -ForegroundColor $color
    }
    
    # Check API endpoint directly
    Write-Host "`n=== API Endpoint Test ===" -ForegroundColor Yellow
    try {
        $apiResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/integrations/x-collector" -UseBasicParsing
        Write-Host "GET /api/integrations/x-collector : Status $($apiResponse.StatusCode)" -ForegroundColor Green
    } catch {
        Write-Host "GET /api/integrations/x-collector : Error - $_" -ForegroundColor Red
    }
    
    # Check if modules section exists
    $moduleSectionMatch = [regex]::Match($html, 'id="(?<id>overview|accounts|proxies|campaigns|ai|security)"')
    if ($moduleSectionMatch.Success) {
        Write-Host "Module anchor sections found: $($moduleSectionMatch.Groups['id'].Value)" -ForegroundColor Green
    }
    
} catch {
    Write-Host "Error fetching page: $_" -ForegroundColor Red
    exit 1
}

Write-Host "`n=== Test Complete ===" -ForegroundColor Cyan
