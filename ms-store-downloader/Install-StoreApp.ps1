<#
.SYNOPSIS
    Installs Store app packages captured by Download-StoreApp.ps1 into a master image,
    provisioning them for all users.

.DESCRIPTION
    Run elevated inside the master image during the build sequence. For each app folder
    (identified by its manifest.json) the script:

      1. Compares the captured version against what is already provisioned/installed in
         the image.
      2. Skips the app if the image already has the same or a newer version (re-provisioning
         would fail with 0x80073D06-style errors).
      3. Otherwise provisions the package machine-wide with Add-AppxProvisionedPackage,
         passing the captured dependencies. An older provisioned version is updated in
         place - no removal needed.
      4. Also updates the copy registered to the current (build/admin) profile, since
         provisioning only affects profiles created after it.

    Use -Force to remove the existing provisioned package and all per-user registrations
    first - required for downgrades or to repair a broken staged package.

.PARAMETER Path
    A folder produced by Download-StoreApp.ps1, or a parent folder containing several of
    them. Every manifest.json found (recursively) is processed. A folder of loose
    .msix/.appx/.msixbundle/.appxbundle files without a manifest also works: well-known
    framework packages (VCLibs, .NET Native, UI.Xaml, ...) are treated as dependencies.

.PARAMETER Force
    Remove any existing provisioned package and per-user installs of the app before
    installing. Use for downgrades or repairing broken installs.

.PARAMETER CurrentUser
    Install for the current user only (Add-AppxPackage) instead of provisioning
    machine-wide. Useful for a quick functional test; does not require elevation.

.EXAMPLE
    .\Install-StoreApp.ps1 -Path D:\StoreApps
    Provisions every captured app under D:\StoreApps into the image.

.EXAMPLE
    .\Install-StoreApp.ps1 -Path D:\StoreApps\Microsoft.CompanyPortal -Force

.NOTES
    Works on Windows PowerShell 5.1 and PowerShell 7+. Fully offline.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateScript({ Test-Path $_ -PathType Container })]
    [string]$Path,

    [switch]$Force,

    [switch]$CurrentUser
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Framework packages that are always dependencies, used when no manifest.json exists
$script:KnownDependencyPrefixes = @(
    'Microsoft.VCLibs', 'Microsoft.NET.Native.Runtime', 'Microsoft.NET.Native.Framework',
    'Microsoft.UI.Xaml', 'Microsoft.WindowsAppRuntime', 'Microsoft.Services.Store.Engagement',
    'Microsoft.Advertising.Xaml'
)
$script:PackageExtensions = @('.msixbundle', '.appxbundle', '.msix', '.appx')

function Test-IsElevated {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-PackageVersionFromFileName {
    param([Parameter(Mandatory)][string]$FileName)
    # Moniker convention: Name_Version_Arch_[ResourceId]_PublisherHash.ext
    $parts = [IO.Path]::GetFileNameWithoutExtension($FileName) -split '_'
    if ($parts.Count -gt 1) {
        try { return [version]$parts[1] } catch { }
    }
    return [version]'0.0.0.0'
}

function Get-AppSets {
    # Returns one object per app to install: Name, MainFiles, DependencyFiles, Version
    param([Parameter(Mandatory)][string]$Root)

    $sets = New-Object System.Collections.Generic.List[object]
    $manifests = @(Get-ChildItem -Path $Root -Filter 'manifest.json' -Recurse -File)

    foreach ($manifestFile in $manifests) {
        $manifest = Get-Content -Path $manifestFile.FullName -Raw | ConvertFrom-Json
        $folder = $manifestFile.DirectoryName
        $mainFiles = @($manifest.mainPackages | ForEach-Object { Join-Path $folder $_ } | Where-Object { Test-Path $_ })
        $depFiles  = @($manifest.dependencies | ForEach-Object { Join-Path $folder $_ } | Where-Object { Test-Path $_ })
        if ($mainFiles.Count -eq 0) {
            Write-Warning "Skipping $folder - manifest lists no main package files that exist on disk."
            continue
        }
        $sets.Add([pscustomobject]@{
            Name            = $manifest.packageIdentityName
            Title           = $manifest.title
            Version         = Get-PackageVersionFromFileName -FileName ([IO.Path]::GetFileName($mainFiles[0]))
            MainFiles       = $mainFiles
            DependencyFiles = $depFiles
            Source          = $folder
        })
    }

    if ($sets.Count -gt 0) { return $sets }

    # No manifest anywhere: fall back to classifying loose package files in $Root
    $files = @(Get-ChildItem -Path $Root -File | Where-Object { $_.Extension.ToLowerInvariant() -in $script:PackageExtensions })
    if ($files.Count -eq 0) {
        throw "No manifest.json and no .msix/.appx package files found under '$Root'."
    }
    $isDependency = { param($file)
        foreach ($prefix in $script:KnownDependencyPrefixes) {
            if ($file.Name -like "$prefix*") { return $true }
        }
        return $false
    }
    $depFiles  = @($files | Where-Object { & $isDependency $_ } | ForEach-Object { $_.FullName })
    $mainFiles = @($files | Where-Object { -not (& $isDependency $_) } | ForEach-Object { $_.FullName })
    if ($mainFiles.Count -eq 0) {
        throw "Only framework/dependency packages found under '$Root' - could not identify a main app package."
    }
    foreach ($main in $mainFiles) {
        $name = ([IO.Path]::GetFileNameWithoutExtension($main) -split '_')[0]
        $sets.Add([pscustomobject]@{
            Name            = $name
            Title           = $name
            Version         = Get-PackageVersionFromFileName -FileName ([IO.Path]::GetFileName($main))
            MainFiles       = @($main)
            DependencyFiles = $depFiles
            Source          = $Root
        })
    }
    return $sets
}

function Install-AppSet {
    param(
        [Parameter(Mandatory)]$App,
        [switch]$Force,
        [switch]$CurrentUser
    )
    Write-Host ("`n=== {0} v{1} ===" -f $App.Title, $App.Version) -ForegroundColor Cyan

    if ($CurrentUser) {
        foreach ($main in $App.MainFiles) {
            Write-Host "  Installing for current user: $([IO.Path]::GetFileName($main))"
            if ($App.DependencyFiles.Count -gt 0) {
                Add-AppxPackage -Path $main -DependencyPath $App.DependencyFiles -ForceUpdateFromAnyVersion:$Force
            } else {
                Add-AppxPackage -Path $main -ForceUpdateFromAnyVersion:$Force
            }
        }
        Write-Host '  Installed for current user.' -ForegroundColor Green
        return
    }

    $existing = Get-AppxProvisionedPackage -Online | Where-Object { $_.DisplayName -eq $App.Name }
    $existingVersion = $null
    if ($existing) {
        $existingVersion = [version]($existing | Select-Object -First 1).Version
        Write-Host ("  Currently provisioned in image: v{0}" -f $existingVersion)
    } else {
        Write-Host '  Not currently provisioned in this image.'
    }

    if ($Force) {
        if ($existing) {
            Write-Host '  -Force: removing existing provisioned package...'
            $existing | Remove-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue | Out-Null
        }
        $installed = @(Get-AppxPackage -AllUsers -Name $App.Name -ErrorAction SilentlyContinue)
        if ($installed.Count -gt 0) {
            Write-Host ("  -Force: removing {0} per-user registration(s)..." -f $installed.Count)
            $installed | Remove-AppxPackage -AllUsers -ErrorAction SilentlyContinue
        }
    }
    elseif ($existingVersion -and $existingVersion -ge $App.Version) {
        Write-Host ("  Skipping: image already has v{0} (>= captured v{1}). Use -Force to reinstall/downgrade." -f $existingVersion, $App.Version) -ForegroundColor Yellow
        return
    }

    foreach ($main in $App.MainFiles) {
        Write-Host "  Provisioning: $([IO.Path]::GetFileName($main))"
        if ($App.DependencyFiles.Count -gt 0) {
            Add-AppxProvisionedPackage -Online -PackagePath $main -DependencyPackagePath $App.DependencyFiles -SkipLicense | Out-Null
        } else {
            Add-AppxProvisionedPackage -Online -PackagePath $main -SkipLicense | Out-Null
        }
    }
    Write-Host '  Provisioned for all new user profiles.' -ForegroundColor Green

    # Provisioning only affects profiles created afterwards. Update the current
    # (build/admin) profile too so the image doesn't carry a stale per-user copy.
    $currentUserCopy = Get-AppxPackage -Name $App.Name -ErrorAction SilentlyContinue
    if ($currentUserCopy -and ([version]($currentUserCopy | Select-Object -First 1).Version) -lt $App.Version) {
        try {
            foreach ($main in $App.MainFiles) {
                if ($App.DependencyFiles.Count -gt 0) {
                    Add-AppxPackage -Path $main -DependencyPath $App.DependencyFiles
                } else {
                    Add-AppxPackage -Path $main
                }
            }
            Write-Host '  Updated the current profile''s copy as well.' -ForegroundColor Green
        }
        catch {
            Write-Warning ("  Could not update the current profile's copy (provisioning itself succeeded): {0}" -f $_.Exception.Message)
        }
    }
}

# ----------------------------------------------------------------------------- main

if (-not $CurrentUser -and -not (Test-IsElevated)) {
    throw 'Provisioning requires an elevated session. Run from an elevated PowerShell, or use -CurrentUser for a per-user test install.'
}

$apps = @(Get-AppSets -Root $Path)
Write-Host ("Found {0} app(s) to install under {1}" -f $apps.Count, $Path)

$failures = 0
foreach ($app in $apps) {
    try {
        Install-AppSet -App $app -Force:$Force -CurrentUser:$CurrentUser
    }
    catch {
        $failures++
        Write-Error -ErrorAction Continue -Message ("Failed to install {0}: {1}" -f $app.Title, $_.Exception.Message)
    }
}

Write-Host ''
if ($failures -gt 0) {
    Write-Warning ("Completed with {0} failure(s) out of {1} app(s)." -f $failures, $apps.Count)
    exit 1
}
Write-Host ("All {0} app(s) processed successfully." -f $apps.Count) -ForegroundColor Green
