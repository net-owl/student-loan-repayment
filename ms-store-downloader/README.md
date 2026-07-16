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
```

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
| `-PackageName` | *(required)* | Store ID (`9…`, 12 chars) or PackageFamilyName (`Name_hash`) |
| `-Destination` | `.\<AppName>` | Output folder |
| `-Architecture` | `x64` | `x64`, `x86`, `arm64` or `all`; neutral packages always included |
| `-Market` / `-Locale` | `US` / `en-US` | Catalog market/language |
| `-Ring` | `Retail` | Release ring (`Retail`, `RP`, `WIS`, `WIF`) |
| `-ListOnly` | off | Resolve and list packages without downloading |

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
