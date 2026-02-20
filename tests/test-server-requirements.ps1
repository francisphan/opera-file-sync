#!/usr/bin/env powershell
<#
.SYNOPSIS
    Tests if the server meets requirements for OPERA to Salesforce sync script

.DESCRIPTION
    Runs comprehensive tests to verify:
    - Windows version
    - Disk space
    - Network connectivity to Salesforce
    - File system access
    - Memory/CPU
    - Optional: SMTP connectivity

.EXAMPLE
    .\test-server-requirements.ps1

.EXAMPLE
    .\test-server-requirements.ps1 -TestSMTP -SMTPHost smtp.gmail.com -SMTPPort 587

.NOTES
    Run this script on the OPERA server to verify it meets all requirements
#>

param(
    [string]$ExportDir = "C:\OPERA\Exports\Reservations",
    [string]$ProcessedDir = "C:\OPERA\Exports\Processed",
    [string]$FailedDir = "C:\OPERA\Exports\Failed",
    [string]$SalesforceInstance = "login.salesforce.com",
    [switch]$TestSMTP,
    [string]$SMTPHost = "smtp.gmail.com",
    [int]$SMTPPort = 587
)

# Colors for output
$Success = "Green"
$Warning = "Yellow"
$Error = "Red"
$Info = "Cyan"

# Test results
$TestResults = @()

function Write-TestHeader {
    param([string]$Title)
    Write-Host "`n$('='*70)" -ForegroundColor $Info
    Write-Host $Title -ForegroundColor $Info
    Write-Host "$('='*70)" -ForegroundColor $Info
}

function Write-TestResult {
    param(
        [string]$TestName,
        [bool]$Passed,
        [string]$Message,
        [string]$Details = ""
    )

    $result = @{
        TestName = $TestName
        Passed = $Passed
        Message = $Message
        Details = $Details
    }
    $script:TestResults += New-Object PSObject -Property $result

    $icon = if ($Passed) { "✓" } else { "✗" }
    $color = if ($Passed) { $Success } else { $Error }

    Write-Host "`n$icon " -NoNewline -ForegroundColor $color
    Write-Host "$TestName" -ForegroundColor $color
    Write-Host "  $Message"
    if ($Details) {
        Write-Host "  $Details" -ForegroundColor Gray
    }
}

# ==============================================================================
# Test 1: Windows Version
# ==============================================================================
Write-TestHeader "Test 1: Windows Version"

try {
    $os = Get-WmiObject Win32_OperatingSystem
    $osName = $os.Caption
    $osVersion = $os.Version
    $osArch = $os.OSArchitecture

    Write-Host "  OS: $osName"
    Write-Host "  Version: $osVersion"
    Write-Host "  Architecture: $osArch"

    # Check if Windows Server 2012 R2 or later
    $versionParts = $osVersion.Split('.')
    $majorVersion = [int]$versionParts[0]
    $minorVersion = [int]$versionParts[1]

    # Windows Server 2012 R2 = 6.3, Server 2016 = 10.0
    $isSupported = ($majorVersion -ge 10) -or ($majorVersion -eq 6 -and $minorVersion -ge 3)

    # Check 64-bit
    $is64bit = $osArch -eq "64-bit"

    if ($isSupported -and $is64bit) {
        Write-TestResult "Windows Version" $true "Supported: $osName ($osVersion) $osArch"
    } elseif (-not $is64bit) {
        Write-TestResult "Windows Version" $false "32-bit Windows is not supported" "Requires 64-bit (x64) Windows"
    } else {
        Write-TestResult "Windows Version" $false "Windows version too old" "Requires Windows Server 2012 R2 or later"
    }
} catch {
    Write-TestResult "Windows Version" $false "Failed to check Windows version" $_.Exception.Message
}

# ==============================================================================
# Test 2: Disk Space
# ==============================================================================
Write-TestHeader "Test 2: Disk Space"

try {
    $drive = Get-PSDrive C
    $freeSpaceGB = [math]::Round($drive.Free / 1GB, 2)
    $usedSpaceGB = [math]::Round($drive.Used / 1GB, 2)
    $totalSpaceGB = [math]::Round(($drive.Free + $drive.Used) / 1GB, 2)
    $freeSpaceMB = [math]::Round($drive.Free / 1MB, 0)

    Write-Host "  Total: $totalSpaceGB GB"
    Write-Host "  Used: $usedSpaceGB GB"
    Write-Host "  Free: $freeSpaceGB GB ($freeSpaceMB MB)"

    $requiredMB = 150
    $passed = $freeSpaceMB -ge $requiredMB

    if ($passed) {
        Write-TestResult "Disk Space" $true "Sufficient space: $freeSpaceGB GB free" "Requires: $requiredMB MB"
    } else {
        Write-TestResult "Disk Space" $false "Insufficient space: only $freeSpaceMB MB free" "Requires: $requiredMB MB"
    }
} catch {
    Write-TestResult "Disk Space" $false "Failed to check disk space" $_.Exception.Message
}

# ==============================================================================
# Test 3: Memory (RAM)
# ==============================================================================
Write-TestHeader "Test 3: Memory (RAM)"

try {
    $os = Get-WmiObject Win32_OperatingSystem
    $totalMemoryGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
    $freeMemoryGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
    $usedMemoryGB = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 2)
    $totalMemoryMB = [math]::Round($os.TotalVisibleMemorySize / 1KB, 0)

    Write-Host "  Total: $totalMemoryGB GB ($totalMemoryMB MB)"
    Write-Host "  Used: $usedMemoryGB GB"
    Write-Host "  Free: $freeMemoryGB GB"

    $requiredMB = 256
    $recommendedMB = 512

    if ($totalMemoryMB -ge $recommendedMB) {
        Write-TestResult "Memory" $true "Sufficient memory: $totalMemoryGB GB ($totalMemoryMB MB)" "Recommended: $recommendedMB MB"
    } elseif ($totalMemoryMB -ge $requiredMB) {
        Write-TestResult "Memory" $true "Minimum memory met: $totalMemoryMB MB" "Recommended: $recommendedMB MB for better performance"
    } else {
        Write-TestResult "Memory" $false "Insufficient memory: only $totalMemoryMB MB" "Requires: $requiredMB MB minimum"
    }
} catch {
    Write-TestResult "Memory" $false "Failed to check memory" $_.Exception.Message
}

# ==============================================================================
# Test 4: CPU
# ==============================================================================
Write-TestHeader "Test 4: CPU"

try {
    $cpu = Get-WmiObject Win32_Processor | Select-Object -First 1
    $cpuName = $cpu.Name
    $cpuCores = $cpu.NumberOfCores
    $cpuLogical = $cpu.NumberOfLogicalProcessors

    Write-Host "  CPU: $cpuName"
    Write-Host "  Cores: $cpuCores"
    Write-Host "  Logical Processors: $cpuLogical"

    # Any modern CPU should work
    Write-TestResult "CPU" $true "CPU detected: $cpuName" "$cpuCores cores, $cpuLogical logical processors"
} catch {
    Write-TestResult "CPU" $false "Failed to check CPU" $_.Exception.Message
}

# ==============================================================================
# Test 5: Network - Salesforce Connectivity
# ==============================================================================
Write-TestHeader "Test 5: Network - Salesforce Connectivity"

Write-Host "  Testing HTTPS connectivity to Salesforce..."
Write-Host "  Target: $SalesforceInstance:443"

try {
    $testConnection = Test-NetConnection -ComputerName $SalesforceInstance -Port 443 -WarningAction SilentlyContinue

    if ($testConnection.TcpTestSucceeded) {
        Write-Host "  Remote Address: $($testConnection.RemoteAddress)"
        Write-Host "  Ping Success: $($testConnection.PingSucceeded)"
        Write-Host "  TCP Test: $($testConnection.TcpTestSucceeded)"

        Write-TestResult "Salesforce Connectivity" $true "Successfully connected to $SalesforceInstance:443" "Network access to Salesforce API is working"
    } else {
        Write-TestResult "Salesforce Connectivity" $false "Cannot connect to $SalesforceInstance:443" "Check firewall rules and network connectivity"
    }
} catch {
    Write-TestResult "Salesforce Connectivity" $false "Failed to test Salesforce connectivity" $_.Exception.Message
}

# Test additional Salesforce domains
Write-Host "`n  Testing additional Salesforce endpoints..."
$sfDomains = @("na1.salesforce.com", "cs1.salesforce.com")
foreach ($domain in $sfDomains) {
    try {
        $test = Test-NetConnection -ComputerName $domain -Port 443 -WarningAction SilentlyContinue -InformationLevel Quiet
        $status = if ($test) { "✓ Accessible" } else { "✗ Not accessible" }
        $color = if ($test) { $Success } else { $Warning }
        Write-Host "  $domain - " -NoNewline
        Write-Host $status -ForegroundColor $color
    } catch {
        Write-Host "  $domain - Error testing" -ForegroundColor $Warning
    }
}

# ==============================================================================
# Test 6: File System - Export Directory Access
# ==============================================================================
Write-TestHeader "Test 6: File System - Export Directory Access"

Write-Host "  Testing directory: $ExportDir"

try {
    # Check if directory exists
    if (Test-Path $ExportDir) {
        Write-Host "  ✓ Directory exists"

        # Test read access
        try {
            Get-ChildItem $ExportDir -ErrorAction Stop | Out-Null
            Write-Host "  ✓ Can read directory"
            $canRead = $true
        } catch {
            Write-Host "  ✗ Cannot read directory" -ForegroundColor $Warning
            $canRead = $false
        }

        # Test write access (create test file)
        $testFile = Join-Path $ExportDir "test-write-access.tmp"
        try {
            "test" | Out-File $testFile -ErrorAction Stop
            Remove-Item $testFile -ErrorAction SilentlyContinue
            Write-Host "  ✓ Can write to directory"
            $canWrite = $true
        } catch {
            Write-Host "  ✗ Cannot write to directory" -ForegroundColor $Warning
            $canWrite = $false
        }

        if ($canRead -and $canWrite) {
            Write-TestResult "Export Directory" $true "Full access to $ExportDir" "Can read and write files"
        } elseif ($canRead) {
            Write-TestResult "Export Directory" $true "Read access to $ExportDir" "Write access not required for export directory"
        } else {
            Write-TestResult "Export Directory" $false "No access to $ExportDir" "Check directory permissions"
        }
    } else {
        Write-Host "  ✗ Directory does not exist" -ForegroundColor $Warning
        Write-TestResult "Export Directory" $false "Directory does not exist: $ExportDir" "Will be created on first run (if permissions allow)"
    }
} catch {
    Write-TestResult "Export Directory" $false "Error checking export directory" $_.Exception.Message
}

# ==============================================================================
# Test 7: File System - Processed/Failed Directories
# ==============================================================================
Write-TestHeader "Test 7: File System - Processed/Failed Directories"

$dirsToTest = @(
    @{Name="Processed"; Path=$ProcessedDir},
    @{Name="Failed"; Path=$FailedDir}
)

$allDirsOk = $true

foreach ($dir in $dirsToTest) {
    Write-Host "`n  Testing $($dir.Name) directory: $($dir.Path)"

    try {
        # Check if exists
        if (-not (Test-Path $dir.Path)) {
            Write-Host "  ✗ Directory does not exist" -ForegroundColor $Warning

            # Try to create it
            try {
                New-Item -ItemType Directory -Path $dir.Path -Force | Out-Null
                Write-Host "  ✓ Successfully created directory" -ForegroundColor $Success
            } catch {
                Write-Host "  ✗ Cannot create directory: $($_.Exception.Message)" -ForegroundColor $Error
                $allDirsOk = $false
                continue
            }
        } else {
            Write-Host "  ✓ Directory exists"
        }

        # Test write access
        $testFile = Join-Path $dir.Path "test-write-access.tmp"
        try {
            "test" | Out-File $testFile -ErrorAction Stop
            Remove-Item $testFile -ErrorAction SilentlyContinue
            Write-Host "  ✓ Can write to directory"
        } catch {
            Write-Host "  ✗ Cannot write to directory: $($_.Exception.Message)" -ForegroundColor $Error
            $allDirsOk = $false
        }
    } catch {
        Write-Host "  ✗ Error: $($_.Exception.Message)" -ForegroundColor $Error
        $allDirsOk = $false
    }
}

if ($allDirsOk) {
    Write-TestResult "Processed/Failed Directories" $true "All directories accessible and writable"
} else {
    Write-TestResult "Processed/Failed Directories" $false "Some directories not accessible" "Check permissions or create manually"
}

# ==============================================================================
# Test 8: SMTP Connectivity (Optional)
# ==============================================================================
if ($TestSMTP) {
    Write-TestHeader "Test 8: SMTP Connectivity (Optional)"

    Write-Host "  Testing SMTP connectivity to email server..."
    Write-Host "  Target: $SMTPHost:$SMTPPort"

    try {
        $testConnection = Test-NetConnection -ComputerName $SMTPHost -Port $SMTPPort -WarningAction SilentlyContinue

        if ($testConnection.TcpTestSucceeded) {
            Write-Host "  Remote Address: $($testConnection.RemoteAddress)"
            Write-Host "  TCP Test: $($testConnection.TcpTestSucceeded)"

            Write-TestResult "SMTP Connectivity" $true "Successfully connected to $SMTPHost:$SMTPPort" "Email notifications can be configured"
        } else {
            Write-TestResult "SMTP Connectivity" $false "Cannot connect to $SMTPHost:$SMTPPort" "Email notifications will not work - check firewall"
        }
    } catch {
        Write-TestResult "SMTP Connectivity" $false "Failed to test SMTP connectivity" $_.Exception.Message
    }
} else {
    Write-Host "`nTest 8: SMTP Connectivity - SKIPPED (use -TestSMTP to enable)" -ForegroundColor $Warning
}

# ==============================================================================
# Test 9: PowerShell Version
# ==============================================================================
Write-TestHeader "Test 9: PowerShell Version"

try {
    $psVersion = $PSVersionTable.PSVersion
    $psVersionString = "$($psVersion.Major).$($psVersion.Minor)"

    Write-Host "  PowerShell Version: $psVersionString"
    Write-Host "  Edition: $($PSVersionTable.PSEdition)"

    # PowerShell 5.1+ recommended for this test script
    if ($psVersion.Major -ge 5) {
        Write-TestResult "PowerShell Version" $true "PowerShell $psVersionString" "Version is sufficient"
    } else {
        Write-TestResult "PowerShell Version" $false "PowerShell version too old: $psVersionString" "PowerShell 5.1+ recommended (but doesn't affect .exe deployment)"
    }
} catch {
    Write-TestResult "PowerShell Version" $false "Failed to check PowerShell version" $_.Exception.Message
}

# ==============================================================================
# Summary
# ==============================================================================
Write-TestHeader "Test Summary"

$totalTests = $TestResults.Count
$passedTests = ($TestResults | Where-Object { $_.Passed }).Count
$failedTests = $totalTests - $passedTests

Write-Host "`nTotal Tests: $totalTests"
Write-Host "Passed: " -NoNewline
Write-Host $passedTests -ForegroundColor $Success
Write-Host "Failed: " -NoNewline
Write-Host $failedTests -ForegroundColor $(if ($failedTests -gt 0) { $Error } else { $Success })

# Show failed tests
if ($failedTests -gt 0) {
    Write-Host "`nFailed Tests:" -ForegroundColor $Error
    $TestResults | Where-Object { -not $_.Passed } | ForEach-Object {
        Write-Host "  ✗ $($_.TestName)" -ForegroundColor $Error
        Write-Host "    $($_.Message)" -ForegroundColor $Warning
        if ($_.Details) {
            Write-Host "    $($_.Details)" -ForegroundColor Gray
        }
    }
}

# Final recommendation
Write-Host "`n$('='*70)" -ForegroundColor $Info
if ($failedTests -eq 0) {
    Write-Host "✓ ALL TESTS PASSED - Server is ready for deployment!" -ForegroundColor $Success
    Write-Host "`nNext steps:" -ForegroundColor $Info
    Write-Host "  1. Build the executable: npm run build:exe"
    Write-Host "  2. Copy dist/opera-sync.exe to this server"
    Write-Host "  3. Create .env configuration file"
    Write-Host "  4. Test run: .\opera-sync.exe"
} else {
    Write-Host "✗ SOME TESTS FAILED - Please address the issues above" -ForegroundColor $Error
    Write-Host "`nRequired actions:" -ForegroundColor $Warning
    $TestResults | Where-Object { -not $_.Passed } | ForEach-Object {
        Write-Host "  • Fix: $($_.TestName)"
    }
}
Write-Host "$('='*70)" -ForegroundColor $Info

# Export results to file
$resultFile = "server-requirements-test-results.txt"
try {
    $TestResults | Format-Table -AutoSize | Out-File $resultFile
    Write-Host "`nDetailed results saved to: $resultFile" -ForegroundColor $Info
} catch {
    Write-Host "`nCould not save results to file" -ForegroundColor $Warning
}
