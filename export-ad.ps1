function First($c) { if ($c.Count) { $c[0] } }

$s = [adsisearcher]'(&(objectCategory=person)(objectClass=user))'
$s.PageSize = 1000
$s.PropertiesToLoad.AddRange(@(
    'samaccountname','displayname','mail','proxyaddresses','useraccountcontrol',
    'department','title','manager','lastlogontimestamp','distinguishedname'))

$results = $s.FindAll()
$rows = foreach ($r in $results) {
    $p   = $r.Properties
    $uac = [int](First $p['useraccountcontrol'])
    $llt = First $p['lastlogontimestamp']
    $mgr = First $p['manager']

    $lastLogon = $null
    if ($llt) { $lastLogon = [DateTime]::FromFileTime($llt).ToString('yyyy-MM-dd') }

    $manager = $null
    if ($mgr) { $manager = ($mgr -replace '^CN=(.+?),(?:OU|CN|DC)=.*$','$1') -replace '\\,',',' }

    $smtp = ($p['proxyaddresses'] | Where-Object { $_ -like 'smtp:*' } |
             ForEach-Object { $_.Substring(5).ToLower() }) -join ';'

    [pscustomobject]@{
        SamAccountName    = First $p['samaccountname']
        DisplayName       = First $p['displayname']
        Mail              = "$(First $p['mail'])".ToLower()
        SmtpAddresses     = $smtp
        Enabled           = -not ($uac -band 2)
        LastLogonDate     = $lastLogon
        Department        = First $p['department']
        Title             = First $p['title']
        Manager           = $manager
        DistinguishedName = First $p['distinguishedname']
    }
}
$results.Dispose()

$out = Join-Path $PSScriptRoot 'ad-users.csv'
$rows | Export-Csv $out -NoTypeInformation -Encoding UTF8

# report.html picks this up through a script tag, which is the only way a
# file:// page can read a local file without you choosing it every time.
$slim = $rows | Where-Object { $_.Mail -or $_.SmtpAddresses } | ForEach-Object {
    [pscustomobject]@{
        name    = $_.DisplayName
        mail    = $_.Mail
        smtp    = $_.SmtpAddresses
        enabled = $_.Enabled
        last    = $_.LastLogonDate
        dept    = $_.Department
        title   = $_.Title
        mgr     = $_.Manager
    }
}
$js = Join-Path $PSScriptRoot 'ad-data.js'
Set-Content -Path $js -Value ("window.__AD = " + ($slim | ConvertTo-Json -Depth 3 -Compress) + ";") -Encoding UTF8

Write-Host "$($rows.Count) accounts to ad-users.csv, $($slim.Count) with addresses to ad-data.js"
"$($rows.Count) users written to $out"