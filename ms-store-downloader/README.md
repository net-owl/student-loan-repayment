# Microsoft Store App Offline Downloader

Capture a Microsoft Store app (msixbundle/appxbundle) **plus all of its dependencies**
(VCLibs, .NET Native, UI.Xaml, …) so it can be installed offline — e.g. while building a
master image for non-persistent VDI, where upgrading Store apps through the Store client
or CLI is unreliable.

Both scripts talk only to Microsoft endpoints (the Store DisplayCatalog API and the FE3
delivery service the Store client itself uses — documented in Microsoft's
[MS-WUSP](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-wusp/) open
specification). No third-party download services are involved.

## Workflow

```
[internet-connected machine]                [master image / image build task]
Download-StoreApp.ps1  ──►  app folder  ──►  Install-StoreApp.ps1
                            (bundle + deps
                             + manifest.json)

[machine with internet, e.g. during image build]
Update-StoreApp.ps1  =  check for update ──► download ──► install, in one step
```

## Accepted package identifiers

Every script's `-PackageName` accepts any of these forms:

| Form | Example | Where it comes from |
|---|---|---|
| Store ID | `9WZDNCRFJ3PZ` | Store URL: `apps.microsoft.com/detail/<StoreId>` |
| PackageFamilyName | `Microsoft.CompanyPortal_8wekyb3d8bbwe` | `Get-AppxPackage` → `PackageFamilyName` |
| Full package name | `Microsoft.CompanyPortal_11.2.183.0_neutral_~_8wekyb3d8bbwe` | `Get-AppxProvisionedPackage -Online` → `PackageName` |
| Identity name | `Microsoft.CompanyPortal` (wildcards OK) | `Get-AppxProvisionedPackage` → `DisplayName`, `Get-AppxPackage` → `Name` |

The identity-name form is resolved against the local machine's installed/provisioned
apps, so it only works where the app is already present; the other three forms work
anywhere.

## 1. Download (any Windows machine with internet)

```powershell
# By Store ID (from the app's URL: https://apps.microsoft.com/detail/9WZDNCRFJ3PZ)
.\Download-StoreApp.ps1 -PackageName 9WZDNCRFJ3PZ

# By PackageFamilyName (from: Get-AppxPackage | Select Name, PackageFamilyName)
.\Download-StoreApp.ps1 -PackageName Microsoft.CompanyPortal_8wekyb3d8bbwe -Destination D:\StoreApps\CompanyPortal

# Preview what would be downloaded
.\Download-StoreApp.ps1 -PackageName 9WZDNCRFJ3PZ -ListOnly
```

| Parameter | Default | Notes |
|---|---|---|
| `-PackageName` | *(required)* | See "Accepted package identifiers" above |
| `-Destination` | `.\<AppName>` | Output folder |
| `-Architecture` | `x64` | `x64`, `x86`, `arm64` or `all`; neutral packages always included |
| `-Market` / `-Locale` | `US` / `en-US` | Catalog market/language |
| `-Ring` | `Retail` | Release ring (`Retail`, `RP`, `WIS`, `WIF`) |
| `-ListOnly` | off | Resolve and list packages without downloading; emits an object with the latest available version |

The output folder contains the app bundle, its dependency packages, and a
`manifest.json` recording which file is the app and which are dependencies.

## 2. Install into the master image (elevated)

```powershell
# One app
.\Install-StoreApp.ps1 -Path D:\StoreApps\CompanyPortal

# Everything under a folder (processes each manifest.json it finds)
.\Install-StoreApp.ps1 -Path D:\StoreApps

# Downgrade or repair: remove existing provisioned/per-user copies first
.\Install-StoreApp.ps1 -Path D:\StoreApps\CompanyPortal -Force

# Quick functional test in the current session only (no elevation needed)
.\Install-StoreApp.ps1 -Path D:\StoreApps\CompanyPortal -CurrentUser
```

Packages are provisioned machine-wide (`Add-AppxProvisionedPackage -Online … -SkipLicense`),
so every profile created afterwards — i.e. every non-persistent VDI logon — gets the
captured version.

### If the image already has a version of the app

You normally do **not** need to remove it first:

- **Image has an older version** → the script provisions directly; Windows updates the
  provisioned registration in place. It also updates the build/admin profile's own copy,
  since provisioning only affects profiles created after it.
- **Image already has the same or a newer version** → the script skips the app
  (re-provisioning would fail with `0x80073D06`-style "higher version installed" errors).
- **Downgrade or broken/staged install** → use `-Force`, which removes the provisioned
  package and all per-user registrations before installing.

## 3. Check + download + install in one step (elevated, needs internet)

`Update-StoreApp.ps1` chains the two scripts: it asks the Store for the latest version,
compares it with what the machine already has (provisioned and per-user), and only if
the Store version is newer (or the app is missing) downloads to a staging folder and
provisions it.

```powershell
# Update one app if the Store has a newer version (identity name resolved locally)
.\Update-StoreApp.ps1 -PackageName Microsoft.CompanyPortal

# Just report what would be updated - no downloads, no changes
.\Update-StoreApp.ps1 -PackageName 9WZDNCRFJ3PZ, Microsoft.WindowsTerminal_8wekyb3d8bbwe -CheckOnly

# Update every Store app currently provisioned in the image
Get-AppxProvisionedPackage -Online |
    ForEach-Object { .\Update-StoreApp.ps1 -PackageName $_.PackageName }
```

| Parameter | Default | Notes |
|---|---|---|
| `-PackageName` | *(required)* | One or more identifiers (see table above) |
| `-CheckOnly` | off | Report installed vs. available versions only |
| `-Force` | off | Reinstall even if the machine is already current (removes existing copies first) |
| `-CurrentUser` | off | Per-user install instead of machine-wide provisioning |
| `-StagingPath` | `<temp>\StoreAppUpdates` | Where downloads are staged |
| `-KeepFiles` | off | Keep the staged packages after installing |
| `-Architecture` / `-Market` / `-Locale` / `-Ring` | as downloader | Passed through to the download step |

Each app yields a result object (`Status`: `UpToDate`, `UpdateAvailable`, `Updated`,
`Installed` or `Failed`) so the script is easy to drive from automation; it exits `1`
if any app failed.

## Starter manifest: popular first-party apps

`first-party-apps.json` is a curated starting list of Microsoft first-party Store apps
that commonly need version pinning in VDI images — Snipping Tool, To Do, Whiteboard,
Company Portal, Notepad, Calculator, Paint, Photos, Sticky Notes, Windows Terminal,
Clock, Media Player, Camera, App Installer (winget), Quick Assist, new Outlook, and new
Teams. Each entry carries both the `storeId` and the `packageFamilyName` (either works
as `-PackageName`), plus notes. Prune or extend it for your environment.

```powershell
$manifest = Get-Content .\first-party-apps.json -Raw | ConvertFrom-Json

# Capture every app in the list (run wherever you stage installers)
foreach ($app in $manifest.apps) {
    .\Download-StoreApp.ps1 -PackageName $app.storeId -Destination "D:\StoreApps\$($app.name)"
}

# ...then in the image build:  .\Install-StoreApp.ps1 -Path D:\StoreApps

# Or report what the image is missing / running behind on
.\Update-StoreApp.ps1 -PackageName $manifest.apps.storeId -CheckOnly

# Or check + download + provision anything outdated, in one step
.\Update-StoreApp.ps1 -PackageName $manifest.apps.storeId
```

Note on new Teams: capturing the MSIX works, but Microsoft's supported VDI route is
`teamsbootstrapper.exe` and the Teams VDI optimization guidance (the WebRTC/SlimCore
media plugins ship separately) — keep it in the list only if that fits your stack.

## Caveats

- **Free apps only.** Paid and line-of-business apps are delivered as encrypted packages
  and cannot be downloaded anonymously; the script detects and reports this.
- **Pin the version by disabling Store auto-update in the image** (GPO:
  *Computer Configuration → Administrative Templates → Windows Components → Store →
  Turn off Automatic Download and Install of updates*). Otherwise the Store may update
  apps at runtime and reintroduce the drift you're trying to avoid.
- The FE3 delivery service is the Store's own distribution channel but not a formally
  supported public API surface; if Microsoft changes it the download script may need
  updating (the MS-WUSP protocol has been stable for many years).
- Downloaded packages are signed by Microsoft/the publisher and verified by Windows at
  install time, so an on-path tampering attempt fails at `Add-AppxProvisionedPackage`.
