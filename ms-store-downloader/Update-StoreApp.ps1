<#
.SYNOPSIS
    Checks whether a newer version of a Microsoft Store app is available and, if so,
    downloads the bundle plus dependencies and installs it - in one step.

.DESCRIPTION
    Combines Download-StoreApp.ps1 and Install-StoreApp.ps1 (both must sit in the same
    folder as this script). For each app given:

      1. Resolves the app and asks the Store's delivery service for the latest version.
      2. Compares it with the version currently provisioned/installed on this machine.
      3. If the Store has a newer version (or the app is missing), downloads the app
         bundle and its dependencies to a staging folder and provisions them.

    Run elevated when provisioning machine-wide (the default). Use -CheckOnly to only
    report whether updates are available, or -CurrentUser for a per-user install.

.PARAMETER PackageName
    One or more apps. Accepts any of:
      - a Store ID, e.g. 9WZDNCRFJ3PZ  (from the Store URL: apps.microsoft.com/detail/<StoreId>)
      - a PackageFamilyName, e.g. Microsoft.CompanyPortal_8wekyb3d8bbwe
      - a full package name, e.g. Microsoft.CompanyPortal_11.2.183.0_neutral_~_8wekyb3d8bbwe
        (the PackageName property of Get-AppxProvisionedPackage / Get-AppxPackage)
      - a package identity name, e.g. Microsoft.CompanyPortal (the DisplayName shown by
        Get-AppxProvisionedPackage), resolved against this machine's apps.

.PARAMETER Architecture
    Package architecture to download: x64 (default), x86, arm64 or all.

.PARAMETER Market
    Store market used for the catalog lookup. Default: US.

.PARAMETER Locale
    Language used for the catalog lookup. Default: en-US.

.PARAMETER Ring
    Release ring: Retail (default), RP, WIS or WIF.

.PARAMETER StagingPath
    Where downloaded packages are staged. Default: <temp>\StoreAppUpdates.
    Each app gets its own subfolder; removed after a successful install unless -KeepFiles.

.PARAMETER CheckOnly
    Only report the installed vs. available version for each app; download/install nothing.

.PARAMETER Force
    Install even when the image already has the same or a newer version (removes the
    existing provisioned package and per-user registrations first, via Install-StoreApp).

.PARAMETER CurrentUser
    Install for the current user only instead of provisioning machine-wide.

.PARAMETER KeepFiles
    Keep the staged download folder after installing (useful to reuse the capture for
    other images).

.EXAMPLE
    .\Update-StoreApp.ps1 -PackageName Microsoft.CompanyPortal
    Updates Company Portal if the Store has a newer version than this machine.

.EXAMPLE
    .\Update-StoreApp.ps1 -PackageName 9WZDNCRFJ3PZ, Microsoft.WindowsTerminal_8wekyb3d8bbwe -CheckOnly

.EXAMPLE
    Get-AppxProvisionedPackage -Online | Where-Object DisplayName -like 'Microsoft.Company*' |
        ForEach-Object { .\Update-StoreApp.ps1 -PackageName $_.PackageName }

.NOTES
    Works on Windows PowerShell 5.1 and PowerShell 7+. Requires internet access.
    Emits one result object per app (Status: UpToDate, UpdateAvailable, Updated,
    Installed or Failed); exits 1 if any app failed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string[]]$PackageName,

    [ValidateSet('x64', 'x86', 'arm64', 'all')]
    [string]$Architecture = 'x64',

    [string]$Market = 'US',

    [string]$Locale = 'en-US',

    [ValidateSet('Retail', 'RP', 'WIS', 'WIF')]
    [string]$Ring = 'Retail',

    [string]$StagingPath,

    [switch]$CheckOnly,

    [switch]$Force,

    [switch]$CurrentUser,

    [switch]$KeepFiles
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$downloader = Join-Path $PSScriptRoot 'Download-StoreApp.ps1'
$installer  = Join-Path $PSScriptRoot 'Install-StoreApp.ps1'
foreach ($tool in @($downloader, $installer)) {
    if (-not (Test-Path $tool)) { throw "Required companion script not found: $tool" }
}
if (-not $StagingPath) { $StagingPath = Join-Path ([IO.Path]::GetTempPath()) 'StoreAppUpdates' }

function Test-IsElevated {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-InstalledVersion {
    # Highest version of the app present on this machine, across the provisioned
    # package and per-user installs. $null if not present at all.
    param([Parameter(Mandatory)][string]$IdentityName)
    $versions = @()
    if (Get-Command Get-AppxProvisionedPackage -ErrorAction SilentlyContinue) {
        try {
            $versions += @(Get-AppxProvisionedPackage -Online -ErrorAction Stop |
                Where-Object { $_.DisplayName -eq $IdentityName } |
                ForEach-Object { [version]$_.Version })
        } catch { }  # needs elevation; per-user check below still applies
    }
    if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
        $installed = @()
        try { $installed = @(Get-AppxPackage -AllUsers -Name $IdentityName -ErrorAction Stop) }
        catch {
            try { $installed = @(Get-AppxPackage -Name $IdentityName -ErrorAction Stop) } catch { }
        }
        $versions += @($installed | ForEach-Object { [version]$_.Version })
    }
    if ($versions.Count -eq 0) { return $null }
    return ($versions | Sort-Object -Descending | Select-Object -First 1)
}

if (-not $CheckOnly -and -not $CurrentUser -and -not (Test-IsElevated)) {
    throw 'Installing machine-wide requires an elevated session. Run elevated, or use -CheckOnly to just report, or -CurrentUser for a per-user install.'
}

$results = New-Object System.Collections.Generic.List[object]
foreach ($id in $PackageName) {
    Write-Host "`n########## $id ##########" -ForegroundColor Magenta
    $result = [pscustomobject]@{
        PackageName      = $id
        Title            = $null
        IdentityName     = $null
        InstalledVersion = $null
        AvailableVersion = $null
        UpdateAvailable  = $false
        Status           = 'Failed'
        Detail           = $null
    }
    $results.Add($result)

    try {
        # Query the Store without downloading; also resolves friendly names/monikers
        $info = & $downloader -PackageName $id -ListOnly -Architecture $Architecture -Market $Market -Locale $Locale -Ring $Ring
        if (-not $info -or -not $info.AvailableVersion) {
            throw "Could not determine the latest available Store version for '$id'."
        }
        $result.Title = $info.Title
        $result.IdentityName = $info.PackageIdentityName
        $result.AvailableVersion = $info.AvailableVersion

        $current = $null
        if ($info.PackageIdentityName) { $current = Get-InstalledVersion -IdentityName $info.PackageIdentityName }
        $result.InstalledVersion = $current
        $result.UpdateAvailable = (-not $current) -or ($info.AvailableVersion -gt $current)

        if ($current) { Write-Host ("Installed: v{0}   Available: v{1}" -f $current, $info.AvailableVersion) }
        else { Write-Host ("Not installed on this machine.   Available: v{0}" -f $info.AvailableVersion) }

        if ($CheckOnly) {
            if ($result.UpdateAvailable) { $result.Status = 'UpdateAvailable' } else { $result.Status = 'UpToDate' }
            continue
        }
        if (-not $result.UpdateAvailable -and -not $Force) {
            $result.Status = 'UpToDate'
            Write-Host 'Already up to date; nothing to do. (Use -Force to reinstall.)' -ForegroundColor Green
            continue
        }

        # Download to a per-app staging folder, then install
        $appStaging = Join-Path $StagingPath $info.PackageIdentityName
        if (Test-Path $appStaging) { Remove-Item $appStaging -Recurse -Force }
        & $downloader -PackageName $info.StoreId -Destination $appStaging -Architecture $Architecture -Market $Market -Locale $Locale -Ring $Ring

        $global:LASTEXITCODE = 0
        & $installer -Path $appStaging -Force:$Force -CurrentUser:$CurrentUser
        if ($LASTEXITCODE -ne 0) { throw "Install-StoreApp.ps1 reported a failure for '$($info.Title)'." }

        # Confirm what's on the machine now
        $newVersion = $null
        if ($info.PackageIdentityName) { $newVersion = Get-InstalledVersion -IdentityName $info.PackageIdentityName }
        if ($newVersion -and $newVersion -ge $info.AvailableVersion) {
            if ($current) { $result.Status = 'Updated' } else { $result.Status = 'Installed' }
            $result.Detail = "now at v$newVersion"
        }
        else {
            $result.Status = 'Updated'
            $result.Detail = 'installed, but the new version could not be verified on this machine'
            Write-Warning $result.Detail
        }

        if (-not $KeepFiles) {
            Remove-Item $appStaging -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            Write-Host "Staged packages kept at $appStaging"
        }
    }
    catch {
        $result.Detail = $_.Exception.Message
        Write-Error -ErrorAction Continue -Message ("{0}: {1}" -f $id, $_.Exception.Message)
    }
}

Write-Host "`n========== Summary ==========" -ForegroundColor Cyan
$results | Format-Table PackageName, InstalledVersion, AvailableVersion, Status, Detail -AutoSize | Out-String | Write-Host

# Emit result objects for pipeline/automation use
$results

$failed = @($results | Where-Object { $_.Status -eq 'Failed' })
if ($failed.Count -gt 0) { exit 1 }
