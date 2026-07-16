<#
.SYNOPSIS
    Downloads a Microsoft Store app package (msixbundle/appxbundle/msix/appx) and all of its
    dependencies directly from Microsoft's delivery endpoints, for offline installation.

.DESCRIPTION
    Intended for capturing critical Store apps so they can be installed/updated during a
    master image build (e.g. non-persistent VDI) without relying on the Store client.

    The script talks only to Microsoft endpoints:
      1. DisplayCatalog API  - resolves the Store product and its Windows Update category ID.
      2. FE3 delivery service (the same SOAP service the Store client uses, documented in
         Microsoft's MS-WUSP open specification) - enumerates the app package and its
         dependency packages (VCLibs, .NET Native, UI.Xaml, ...) and returns download URLs.

    Output: a folder containing the app bundle, its dependency packages, and a manifest.json
    describing the install order. Feed that folder to Install-StoreApp.ps1 in the image build.

    Only free, unencrypted Store apps can be downloaded anonymously. Paid or
    line-of-business apps are served encrypted and cannot be captured this way.

.PARAMETER PackageName
    The app to download. Accepts any of:
      - a Store ID, e.g. 9WZDNCRFJ3PZ or XP8BT8DW290MPQ
        (from the Store URL: apps.microsoft.com/detail/<StoreId>)
      - a PackageFamilyName, e.g. Microsoft.CompanyPortal_8wekyb3d8bbwe  (from Get-AppxPackage)
      - a full package name, e.g. Microsoft.CompanyPortal_11.2.183.0_neutral_~_8wekyb3d8bbwe
        (the PackageName property of Get-AppxProvisionedPackage / Get-AppxPackage)
      - a package identity name, e.g. Microsoft.CompanyPortal (the DisplayName shown by
        Get-AppxProvisionedPackage). Wildcards allowed. Resolved against this machine's
        installed/provisioned apps, so this form only works where the app is present.

.PARAMETER Destination
    Folder to download into. Defaults to .\<PackageIdentityName>. Created if missing.

.PARAMETER Architecture
    Package architecture to keep: x64 (default), x86, arm64 or all.
    Architecture-neutral packages (most app bundles) are always included.

.PARAMETER Market
    Store market used for the catalog lookup. Default: US.

.PARAMETER Locale
    Language used for the catalog lookup. Default: en-US.

.PARAMETER Ring
    Release ring: Retail (default), RP, WIS or WIF.

.PARAMETER ListOnly
    Resolve and list the packages that would be downloaded, without downloading anything.
    Emits an object with the app's identity and the latest available version, consumed by
    Update-StoreApp.ps1 for its update check.

.EXAMPLE
    .\Download-StoreApp.ps1 -PackageName 9WZDNCRFJ3PZ
    Downloads Company Portal and its dependencies into .\Microsoft.CompanyPortal

.EXAMPLE
    .\Download-StoreApp.ps1 -PackageName Microsoft.WindowsTerminal_8wekyb3d8bbwe -Destination D:\StoreApps\Terminal

.EXAMPLE
    .\Download-StoreApp.ps1 -PackageName 9WZDNCRFJ3PZ -Architecture all -ListOnly

.NOTES
    Works on Windows PowerShell 5.1 and PowerShell 7+. Requires internet access.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$PackageName,

    [Parameter(Position = 1)]
    [string]$Destination,

    [ValidateSet('x64', 'x86', 'arm64', 'all')]
    [string]$Architecture = 'x64',

    [string]$Market = 'US',

    [string]$Locale = 'en-US',

    [ValidateSet('Retail', 'RP', 'WIS', 'WIF')]
    [string]$Ring = 'Retail',

    [switch]$ListOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# TLS 1.2 for Windows PowerShell 5.1 (default there is often TLS 1.0/1.1)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:Fe3Endpoint        = 'https://fe3cr.delivery.mp.microsoft.com/ClientWebService/client.asmx'
$script:Fe3SecuredEndpoint = 'https://fe3cr.delivery.mp.microsoft.com/ClientWebService/client.asmx/secured'
$script:WuNamespace        = 'http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService'
$script:UserAgent          = 'Windows-Update-Agent/10.0.10011.16384 Client-Protocol/2.1'

# Device attributes reported to the delivery service; determines which packages are
# considered applicable. {0} = flight ring.
$script:DeviceAttributesTemplate = 'E:BranchReadinessLevel=CB&amp;CurrentBranch=rs_prerelease&amp;OEMModel=Virtual%20Machine&amp;FlightRing={0}&amp;AttrDataVer=21&amp;SystemManufacturer=Microsoft&amp;InstallLanguage=en-US&amp;OSUILocale=en-US&amp;InstallationType=Client&amp;FlightingBranchName=external&amp;FirmwareVersion=Hyper-V%20UEFI%20Release%20v2.5&amp;SystemProductName=Virtual%20Machine&amp;OSSkuId=48&amp;FlightContent=Branch&amp;App=WU_STORE&amp;OEMName_Uncleaned=Microsoft%20Corporation&amp;AppVer=10.0.22621.755&amp;OSArchitecture=AMD64&amp;SystemSKU=None&amp;UpdateManagementGroup=2&amp;IsFlightingEnabled=0&amp;IsDeviceRetailDemo=0&amp;TelemetryLevel=3&amp;OSVersion=10.0.22621.755&amp;DeviceFamily=Windows.Desktop'

function Invoke-WithRetry {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [string]$Description = 'request',
        [int]$MaxAttempts = 4
    )
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            return & $Action
        }
        catch {
            if ($attempt -ge $MaxAttempts) { throw }
            $delay = [math]::Pow(2, $attempt)  # 2, 4, 8s
            Write-Warning ("{0} failed (attempt {1}/{2}): {3} - retrying in {4}s" -f $Description, $attempt, $MaxAttempts, $_.Exception.Message, $delay)
            Start-Sleep -Seconds $delay
        }
    }
}

function Get-SecurityHeaderXml {
    # WS-Security header with an anonymous MSA ticket - sufficient for free apps.
    $created = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
    $expires = [DateTime]::UtcNow.AddMinutes(5).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
    return @"
        <o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
            <Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
                <Created>$created</Created>
                <Expires>$expires</Expires>
            </Timestamp>
            <wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization">
                <TicketType Name="MSA" Version="1.0" Policy="MBI_SSL">
                    <User></User>
                </TicketType>
            </wuws:WindowsUpdateTicketsToken>
        </o:Security>
"@
}

function Invoke-Fe3Request {
    param(
        [Parameter(Mandatory)][string]$Action,      # e.g. GetCookie
        [Parameter(Mandatory)][string]$BodyXml,     # contents of <s:Body>
        [switch]$Secured
    )
    $endpoint = if ($Secured) { $script:Fe3SecuredEndpoint } else { $script:Fe3Endpoint }
    $envelope = @"
<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">
    <s:Header>
        <a:Action s:mustUnderstand="1">$($script:WuNamespace)/$Action</a:Action>
        <a:MessageID>urn:uuid:$([guid]::NewGuid().ToString())</a:MessageID>
        <a:To s:mustUnderstand="1">$endpoint</a:To>
$(Get-SecurityHeaderXml)
    </s:Header>
    <s:Body>
$BodyXml
    </s:Body>
</s:Envelope>
"@
    $response = Invoke-WithRetry -Description "FE3 $Action" -Action {
        Invoke-WebRequest -Uri $endpoint -Method Post -Body $envelope -UseBasicParsing `
            -ContentType 'application/soap+xml; charset=utf-8' -UserAgent $script:UserAgent
    }
    return [xml]$response.Content
}

function Convert-ToPackageFamilyName {
    # Normalizes an identifier to a PackageFamilyName. Accepts a PackageFamilyName as-is,
    # derives one from a full package name (Name_Version_Arch_ResourceId_PublisherHash,
    # as shown by Get-AppxProvisionedPackage/Get-AppxPackage), or resolves a bare identity
    # name against this machine's installed/provisioned apps. Returns $null if unresolvable.
    param([Parameter(Mandatory)][string]$Identifier)

    if ($Identifier -match '^[^_]+_[a-z0-9]{13}$') { return $Identifier }

    $parts = $Identifier -split '_'
    if ($parts.Count -ge 4 -and $parts[1] -match '^\d+(\.\d+){1,3}$' -and $parts[-1] -match '^[a-z0-9]{13}$') {
        return '{0}_{1}' -f $parts[0], $parts[-1]
    }

    # Bare identity name (e.g. Microsoft.CompanyPortal): look it up locally
    if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
        $found = @()
        try { $found = @(Get-AppxPackage -AllUsers -Name $Identifier -ErrorAction Stop) }
        catch {
            try { $found = @(Get-AppxPackage -Name $Identifier -ErrorAction Stop) } catch { }
        }
        $familyNames = @($found | ForEach-Object { $_.PackageFamilyName } | Sort-Object -Unique)
        if ($familyNames.Count -eq 1) { return $familyNames[0] }
        if ($familyNames.Count -gt 1) {
            throw "'$Identifier' matches more than one installed package: $($familyNames -join ', '). Use one of those PackageFamilyNames."
        }
    }
    if (Get-Command Get-AppxProvisionedPackage -ErrorAction SilentlyContinue) {
        $provisioned = @()
        try { $provisioned = @(Get-AppxProvisionedPackage -Online -ErrorAction Stop | Where-Object { $_.DisplayName -like $Identifier }) } catch { }
        $familyNames = @($provisioned | ForEach-Object {
            $p = $_.PackageName -split '_'
            '{0}_{1}' -f $p[0], $p[-1]
        } | Sort-Object -Unique)
        if ($familyNames.Count -eq 1) { return $familyNames[0] }
        if ($familyNames.Count -gt 1) {
            throw "'$Identifier' matches more than one provisioned package: $($familyNames -join ', '). Use one of those PackageFamilyNames."
        }
    }
    return $null
}

function Resolve-StoreProduct {
    param(
        [Parameter(Mandatory)][string]$Identifier,
        [Parameter(Mandatory)][string]$Market,
        [Parameter(Mandatory)][string]$Locale
    )
    # Store IDs are 12 alphanumerics starting with 9, or the newer 14-character
    # XP-prefixed form (e.g. new Teams); everything else is normalized to a
    # PackageFamilyName.
    if ($Identifier -match '^(9[A-Za-z0-9]{11}|XP[A-Za-z0-9]{12})$') {
        $uri = "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=$Identifier&market=$Market&languages=$Locale,neutral"
    }
    else {
        $familyName = Convert-ToPackageFamilyName -Identifier $Identifier
        if (-not $familyName) {
            throw "Could not resolve package identifier '$Identifier'. Provide a Store ID (e.g. 9WZDNCRFJ3PZ, from the app's Store URL), a PackageFamilyName (e.g. Microsoft.CompanyPortal_8wekyb3d8bbwe), a full package name (from Get-AppxProvisionedPackage), or - on a machine where the app is installed or provisioned - its identity name (e.g. Microsoft.CompanyPortal)."
        }
        if ($familyName -ne $Identifier) {
            Write-Host "  Resolved '$Identifier' to PackageFamilyName '$familyName'"
        }
        $uri = "https://displaycatalog.mp.microsoft.com/v7.0/products/lookup?market=$Market&languages=$Locale,neutral&alternateId=PackageFamilyName&value=$familyName"
    }

    Write-Verbose "DisplayCatalog: $uri"
    $response = Invoke-WithRetry -Description 'DisplayCatalog lookup' -Action {
        Invoke-RestMethod -Uri $uri -UseBasicParsing -Headers @{ 'MS-CV' = [guid]::NewGuid().ToString() }
    }

    $product = $null
    if ($response.PSObject.Properties['Products'] -and $response.Products) { $product = $response.Products | Select-Object -First 1 }
    elseif ($response.PSObject.Properties['Product'] -and $response.Product) { $product = $response.Product }
    if (-not $product) {
        throw "No Store product found for '$Identifier' in market '$Market'. Check the identifier, or try a different -Market."
    }

    $title = $null
    if ($product.LocalizedProperties) { $title = ($product.LocalizedProperties | Select-Object -First 1).ProductTitle }

    $fulfillmentJson = $null
    foreach ($avail in @($product.DisplaySkuAvailabilities)) {
        if ($avail.Sku -and $avail.Sku.Properties -and $avail.Sku.Properties.FulfillmentData) {
            $fulfillmentJson = $avail.Sku.Properties.FulfillmentData
            break
        }
    }
    if (-not $fulfillmentJson) {
        throw "Product '$title' ($($product.ProductId)) has no fulfillment data. It is likely not a packaged (MSIX/APPX) app - Win32 Store apps and paid apps cannot be downloaded this way."
    }
    $fulfillment = $fulfillmentJson | ConvertFrom-Json
    if (-not $fulfillment.WuCategoryId) {
        throw "Product '$title' has no Windows Update category ID; it cannot be downloaded through the delivery service."
    }

    $pfn = $fulfillment.PackageFamilyName
    if (-not $pfn -and $product.Properties -and $product.Properties.PSObject.Properties['PackageFamilyName']) {
        $pfn = $product.Properties.PackageFamilyName
    }
    $identityName = if ($pfn) { ($pfn -split '_')[0] } else { $null }

    [pscustomobject]@{
        StoreId             = $product.ProductId
        Title               = $title
        PackageFamilyName   = $pfn
        PackageIdentityName = $identityName
        WuCategoryId        = $fulfillment.WuCategoryId
    }
}

function Get-Fe3Cookie {
    $body = @"
        <GetCookie xmlns="$($script:WuNamespace)">
            <oldCookie></oldCookie>
            <lastChange>2015-10-21T17:01:07.1472913Z</lastChange>
            <currentTime>$([DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"))</currentTime>
            <protocolVersion>1.40</protocolVersion>
        </GetCookie>
"@
    $doc = Invoke-Fe3Request -Action 'GetCookie' -BodyXml $body
    $result = $doc.GetElementsByTagName('GetCookieResult') | Select-Object -First 1
    if (-not $result) { throw 'GetCookie: no cookie in response from the delivery service.' }
    [pscustomobject]@{
        Expiration    = $result['Expiration'].InnerText
        EncryptedData = $result['EncryptedData'].InnerText
    }
}

function Get-Fe3Packages {
    param(
        [Parameter(Mandatory)]$Cookie,
        [Parameter(Mandatory)][string]$WuCategoryId,
        [Parameter(Mandatory)][string]$Ring
    )
    # Baseline detectoid/category IDs every WU client reports as installed; the standard
    # list used by Store package download tooling.
    $nonLeafIds = @(
        1, 2, 3, 11, 19, 544, 549, 2359974, 2359977, 5143990, 5169043, 5169044, 5169047,
        8788830, 8806526, 9125350, 9154769, 10809856, 23110993, 23110994, 23110995, 23110996,
        23110999, 23111000, 23111001, 23111002, 23111003, 23111004, 24513870, 28880263,
        30077688, 30486944, 59830006, 59830007, 59830008, 60484010, 62450018, 62450019,
        62450020, 66027979, 66053150, 97657898, 98822896, 98959022, 98959023, 98959024,
        98959025, 98959026, 104433538, 104900364, 105489019, 117765322, 129905029,
        130040030, 130040031, 130040032, 130040033, 133399034, 138372035, 138372036,
        139536037, 139536038, 139536039, 139536040, 142045136, 158941041, 158941042,
        158941043, 158941044, 159776047, 160733048, 160733049, 160733050, 160733051,
        160733055, 160733056, 161870057, 161870058, 161870059
    )
    $nonLeafXml = ($nonLeafIds | ForEach-Object { "                <int>$_</int>" }) -join "`r`n"
    $deviceAttributes = $script:DeviceAttributesTemplate -f $Ring

    $body = @"
        <SyncUpdates xmlns="$($script:WuNamespace)">
            <cookie>
                <Expiration>$($Cookie.Expiration)</Expiration>
                <EncryptedData>$($Cookie.EncryptedData)</EncryptedData>
            </cookie>
            <parameters>
                <ExpressQuery>false</ExpressQuery>
                <InstalledNonLeafUpdateIDs>
$nonLeafXml
                </InstalledNonLeafUpdateIDs>
                <OtherCachedUpdateIDs></OtherCachedUpdateIDs>
                <SkipSoftwareSync>false</SkipSoftwareSync>
                <NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates>
                <FilterAppCategoryIds>
                    <CategoryIdentifier>
                        <Id>$WuCategoryId</Id>
                    </CategoryIdentifier>
                </FilterAppCategoryIds>
                <TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled>
                <AlsoPerformRegularSync>false</AlsoPerformRegularSync>
                <ComputerSpec/>
                <ExtendedUpdateInfoParameters>
                    <XmlUpdateFragmentTypes>
                        <XmlUpdateFragmentType>Extended</XmlUpdateFragmentType>
                    </XmlUpdateFragmentTypes>
                    <Locales>
                        <string>en-US</string>
                        <string>en</string>
                    </Locales>
                </ExtendedUpdateInfoParameters>
                <ClientPreferredLanguages></ClientPreferredLanguages>
                <ProductsParameters>
                    <SyncCurrentVersionOnly>false</SyncCurrentVersionOnly>
                    <DeviceAttributes>$deviceAttributes</DeviceAttributes>
                    <CallerAttributes>E:Interactive=1&amp;IsSeeker=0&amp;SheddingAware=1&amp;</CallerAttributes>
                    <Products></Products>
                </ProductsParameters>
            </parameters>
        </SyncUpdates>
"@
    $doc = Invoke-Fe3Request -Action 'SyncUpdates' -BodyXml $body

    # Update identities (UpdateID/RevisionNumber) come from NewUpdates; the file metadata
    # (names, digests, sizes) comes from the ExtendedUpdateInfo section. Both are keyed by
    # the same numeric server ID.
    $identities = @{}
    foreach ($info in $doc.GetElementsByTagName('UpdateInfo')) {
        $idNode = $info['ID']; $xmlNode = $info['Xml']
        if (-not $idNode -or -not $xmlNode) { continue }
        $fragmentText = $xmlNode.InnerText
        if ($fragmentText -notlike '*SecuredFragment*') { continue }  # only downloadable leaf content
        try { $fragment = [xml]"<r>$fragmentText</r>" } catch { continue }
        $identity = $fragment.SelectSingleNode('//UpdateIdentity')
        if ($identity) {
            $identities[$idNode.InnerText] = [pscustomobject]@{
                UpdateId       = $identity.GetAttribute('UpdateID')
                RevisionNumber = $identity.GetAttribute('RevisionNumber')
            }
        }
    }

    $packages = New-Object System.Collections.Generic.List[object]
    $extended = $doc.GetElementsByTagName('ExtendedUpdateInfo') | Select-Object -First 1
    if ($extended) {
        foreach ($update in $extended.GetElementsByTagName('Update')) {
            $idNode = $update['ID']; $xmlNode = $update['Xml']
            if (-not $idNode -or -not $xmlNode -or -not $identities.ContainsKey($idNode.InnerText)) { continue }
            try { $fragment = [xml]"<r>$($xmlNode.InnerText)</r>" } catch { continue }
            foreach ($file in $fragment.SelectNodes('//File')) {
                $fileName = $file.GetAttribute('FileName')
                if (-not $fileName -or $fileName -like '*.BlockMap') { continue }
                $moniker = $file.GetAttribute('InstallerSpecificIdentifier')
                if (-not $moniker) { $moniker = [IO.Path]::GetFileNameWithoutExtension($fileName) }
                $extension = [IO.Path]::GetExtension($fileName)

                # Package moniker convention: Name_Version_Arch_[ResourceId]_PublisherHash
                $parts = $moniker -split '_'
                $pkgName = $parts[0]
                $version = if ($parts.Count -gt 1) { $parts[1] } else { '0.0.0.0' }
                $arch = if ($parts.Count -gt 2) { $parts[2].ToLowerInvariant() } else { 'neutral' }

                $sizeText = $file.GetAttribute('Size')
                $packages.Add([pscustomobject]@{
                    FileName       = "$moniker$extension"
                    PackageName    = $pkgName
                    Version        = $version
                    Architecture   = $arch
                    Extension      = $extension.ToLowerInvariant()
                    IsBundle       = $extension -match '(?i)bundle$'
                    IsEncrypted    = $extension -match '(?i)^\.e(appx|msix)'
                    Digest         = $file.GetAttribute('Digest')
                    Size           = if ($sizeText) { [long]$sizeText } else { 0 }
                    UpdateId       = $identities[$idNode.InnerText].UpdateId
                    RevisionNumber = $identities[$idNode.InnerText].RevisionNumber
                })
            }
        }
    }
    return $packages
}

function Get-Fe3FileUrls {
    param(
        [Parameter(Mandatory)][string]$UpdateId,
        [Parameter(Mandatory)][string]$RevisionNumber,
        [Parameter(Mandatory)][string]$Ring
    )
    $deviceAttributes = $script:DeviceAttributesTemplate -f $Ring
    $body = @"
        <GetExtendedUpdateInfo2 xmlns="$($script:WuNamespace)">
            <updateIDs>
                <UpdateIdentity>
                    <UpdateID>$UpdateId</UpdateID>
                    <RevisionNumber>$RevisionNumber</RevisionNumber>
                </UpdateIdentity>
            </updateIDs>
            <infoTypes>
                <XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType>
                <XmlUpdateFragmentType>FileDecryption</XmlUpdateFragmentType>
            </infoTypes>
            <deviceAttributes>$deviceAttributes</deviceAttributes>
        </GetExtendedUpdateInfo2>
"@
    $doc = Invoke-Fe3Request -Action 'GetExtendedUpdateInfo2' -BodyXml $body -Secured
    $locations = @()
    foreach ($location in $doc.GetElementsByTagName('FileLocation')) {
        $locations += [pscustomobject]@{
            FileDigest = $location['FileDigest'].InnerText
            Url        = $location['Url'].InnerText
        }
    }
    return $locations
}

function Select-Packages {
    param(
        [Parameter(Mandatory)]$Packages,
        [Parameter(Mandatory)][string]$Architecture
    )
    $selected = New-Object System.Collections.Generic.List[object]
    $groups = $Packages | Where-Object { -not $_.IsEncrypted } |
        Group-Object { '{0}|{1}' -f $_.PackageName.ToLowerInvariant(), $_.Architecture }

    foreach ($group in $groups) {
        $candidates = $group.Group
        # Prefer bundles over loose packages of the same name/arch
        if ($candidates | Where-Object IsBundle) { $candidates = $candidates | Where-Object IsBundle }
        # Keep only the highest version
        $best = $candidates | Sort-Object {
            try { [version]$_.Version } catch { [version]'0.0.0.0' }
        } -Descending | Select-Object -First 1
        $selected.Add($best)
    }

    $result = $selected.ToArray()
    if ($Architecture -ne 'all') {
        $result = @($result | Where-Object { $_.Architecture -in @($Architecture, 'neutral', 'universal') })
    }
    return $result
}

# ----------------------------------------------------------------------------- main

Write-Host "Resolving '$PackageName' in the Microsoft Store catalog..." -ForegroundColor Cyan
$product = Resolve-StoreProduct -Identifier $PackageName -Market $Market -Locale $Locale
Write-Host ("  {0}  (StoreId: {1}, PackageFamilyName: {2})" -f $product.Title, $product.StoreId, $product.PackageFamilyName)

Write-Host 'Querying the delivery service for packages...' -ForegroundColor Cyan
$cookie = Get-Fe3Cookie
$allPackages = Get-Fe3Packages -Cookie $cookie -WuCategoryId $product.WuCategoryId -Ring $Ring
if (-not $allPackages -or $allPackages.Count -eq 0) {
    throw "The delivery service returned no packages for '$($product.Title)'. The app may be a Win32/hosted app, paid, or not available in market '$Market'."
}

$encryptedOnly = -not ($allPackages | Where-Object { -not $_.IsEncrypted })
if ($encryptedOnly) {
    throw "'$($product.Title)' is only available as encrypted packages (paid or line-of-business app); it cannot be downloaded anonymously."
}

$selected = Select-Packages -Packages $allPackages -Architecture $Architecture
if (-not $selected -or $selected.Count -eq 0) {
    throw "No packages matched architecture '$Architecture'. Re-run with -Architecture all to see everything available."
}

$mainName = $product.PackageIdentityName
$mainPackages = @($selected | Where-Object { $mainName -and $_.PackageName -eq $mainName })
$dependencies = @($selected | Where-Object { -not $mainName -or $_.PackageName -ne $mainName })
if ($mainPackages.Count -eq 0) {
    Write-Warning "Could not identify the main app package by name '$mainName'; treating every downloaded package as a dependency. Review the output folder manually."
}

$availableVersion = $null
foreach ($pkg in $mainPackages) {
    try { $v = [version]$pkg.Version } catch { continue }
    if (-not $availableVersion -or $v -gt $availableVersion) { $availableVersion = $v }
}

Write-Host ''
Write-Host ("Packages selected ({0} of {1} returned):" -f $selected.Count, $allPackages.Count) -ForegroundColor Cyan
foreach ($pkg in ($selected | Sort-Object PackageName)) {
    $role = if ($mainPackages -contains $pkg) { 'app       ' } else { 'dependency' }
    $sizeMb = if ($pkg.Size -gt 0) { '{0,8:N1} MB' -f ($pkg.Size / 1MB) } else { '        ? MB' }
    Write-Host ("  [{0}] {1}  {2}" -f $role, $sizeMb, $pkg.FileName)
}

if ($ListOnly) {
    Write-Host "`n-ListOnly specified; nothing downloaded." -ForegroundColor Yellow
    return [pscustomobject]@{
        Title               = $product.Title
        StoreId             = $product.StoreId
        PackageFamilyName   = $product.PackageFamilyName
        PackageIdentityName = $product.PackageIdentityName
        AvailableVersion    = $availableVersion
        Packages            = $selected
    }
}

if (-not $Destination) {
    $folderName = if ($product.PackageIdentityName) { $product.PackageIdentityName } else { $product.StoreId }
    $Destination = Join-Path (Get-Location) $folderName
}
$null = New-Item -ItemType Directory -Path $Destination -Force

Write-Host "`nDownloading to $Destination ..." -ForegroundColor Cyan
$downloaded = New-Object System.Collections.Generic.List[object]
foreach ($pkg in $selected) {
    Write-Host ("  {0} ..." -f $pkg.FileName)
    $locations = Get-Fe3FileUrls -UpdateId $pkg.UpdateId -RevisionNumber $pkg.RevisionNumber -Ring $Ring

    # Match this package's file by digest; fall back to the plain package CDN host
    # (encrypted variants are served from a different host).
    $location = $locations | Where-Object { $_.FileDigest -eq $pkg.Digest } | Select-Object -First 1
    if (-not $location) {
        $location = $locations | Where-Object { $_.Url -like '*tlu.dl.delivery.mp.microsoft.com*' } | Select-Object -First 1
    }
    if (-not $location) {
        Write-Warning ("    no download URL returned for {0}; skipping" -f $pkg.FileName)
        continue
    }

    $url = $location.Url -replace '^http://', 'https://'
    $targetPath = Join-Path $Destination $pkg.FileName
    Invoke-WithRetry -Description ("download {0}" -f $pkg.FileName) -Action {
        $previousProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'   # dramatically faster on PowerShell 5.1
        try { Invoke-WebRequest -Uri $url -OutFile $targetPath -UseBasicParsing }
        finally { $ProgressPreference = $previousProgress }
    }

    $actualSize = (Get-Item $targetPath).Length
    Write-Host ("    done ({0:N1} MB)" -f ($actualSize / 1MB))
    $downloaded.Add([pscustomobject]@{
        file         = $pkg.FileName
        packageName  = $pkg.PackageName
        version      = $pkg.Version
        architecture = $pkg.Architecture
        isBundle     = $pkg.IsBundle
        isMain       = ($mainPackages -contains $pkg)
        sizeBytes    = $actualSize
    })
}

if ($downloaded.Count -eq 0) {
    throw 'No files were downloaded.'
}

# manifest.json drives Install-StoreApp.ps1: dependencies first, then the main bundle(s)
$manifest = [pscustomobject]@{
    schemaVersion       = 1
    title               = $product.Title
    storeId             = $product.StoreId
    packageFamilyName   = $product.PackageFamilyName
    packageIdentityName = $product.PackageIdentityName
    architecture        = $Architecture
    ring                = $Ring
    downloadedUtc       = [DateTime]::UtcNow.ToString('o')
    dependencies        = @($downloaded | Where-Object { -not $_.isMain } | ForEach-Object { $_.file })
    mainPackages        = @($downloaded | Where-Object { $_.isMain } | ForEach-Object { $_.file })
    files               = $downloaded.ToArray()
}
$manifestPath = Join-Path $Destination 'manifest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

Write-Host ''
Write-Host ("Done. {0} file(s) plus manifest.json in {1}" -f $downloaded.Count, $Destination) -ForegroundColor Green
Write-Host 'Install during image build with:  .\Install-StoreApp.ps1 -Path <that folder>'
