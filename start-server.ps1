$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd('\') + '\'
$address = "http://127.0.0.1:8000/"

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css" = "text/css; charset=utf-8"
    ".js" = "text/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".webmanifest" = "application/manifest+json; charset=utf-8"
    ".png" = "image/png"
    ".jpg" = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".webp" = "image/webp"
    ".svg" = "image/svg+xml"
    ".ico" = "image/x-icon"
    ".woff" = "font/woff"
    ".woff2" = "font/woff2"
    ".txt" = "text/plain; charset=utf-8"
}

function Send-TextResponse {
    param($Response, [int]$Status, [string]$Message)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Message)
    $Response.StatusCode = $Status
    $Response.ContentType = "text/plain; charset=utf-8"
    $Response.ContentLength64 = $bytes.Length
    $Response.Headers["Cache-Control"] = "no-store"
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($address)

try {
    $listener.Start()
}
catch {
    Write-Host "SERVER START FAILED" -ForegroundColor Red
    Write-Host $_.Exception.Message
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "======================================" -ForegroundColor DarkGray
Write-Host "              ECHO" -ForegroundColor White
Write-Host "          LOCAL SERVER" -ForegroundColor Gray
Write-Host "======================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "SERVER IS RUNNING" -ForegroundColor Green
Write-Host "Address: http://127.0.0.1:8000/"
Write-Host ""
Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow
Write-Host ""

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        try {
            $relativePath = [Uri]::UnescapeDataString($request.Url.AbsolutePath.TrimStart('/'))
            if ([string]::IsNullOrWhiteSpace($relativePath)) {
                $relativePath = "index.html"
            }

            $relativePath = $relativePath.Replace('/', '\')
            $filePath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $relativePath))

            if (-not $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                Send-TextResponse $response 403 "Access denied."
            }
            elseif (-not [System.IO.File]::Exists($filePath)) {
                Send-TextResponse $response 404 "File not found."
            }
            else {
                $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
                $contentType = $mimeTypes[$extension]
                if (-not $contentType) {
                    $contentType = "application/octet-stream"
                }

                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $response.StatusCode = 200
                $response.ContentType = $contentType
                $response.ContentLength64 = $bytes.Length
                $response.Headers["Cache-Control"] = "no-store"

                if ($request.HttpMethod -ne "HEAD") {
                    $response.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            }
        }
        catch {
            Write-Host "Request error:" $_.Exception.Message -ForegroundColor Red
            try {
                Send-TextResponse $response 500 "Internal server error."
            }
            catch {}
        }
        finally {
            $response.Close()
        }
    }
}
finally {
    $listener.Stop()
    $listener.Close()
    Write-Host "SERVER STOPPED"
}
