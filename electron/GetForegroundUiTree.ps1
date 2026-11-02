# GetForegroundUiTree.ps1
# Dumps the UI tree of the current foreground window via UIAutomation
param(
  [int]$MaxDepth = 10
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# Windows API to get foreground window
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@

$hwnd = [Win32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output "No foreground window found."
} else {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $root) {
        Write-Output "Could not get AutomationElement for foreground window."
    } else {
        # Only get controls, ignoring structural layouts to keep tree clean
        $cond = [System.Windows.Automation.Automation]::ControlViewCondition
        $sb = New-Object System.Text.StringBuilder

        function Fmt($el, $depth) {
            try {
                $c = $el.Current
                $r = $c.BoundingRectangle
                if ($r.IsEmpty -or $c.IsOffscreen) { return }

                $n = $c.Name
                if ([string]::IsNullOrWhiteSpace($n)) { $n = $c.AutomationId }
                if ([string]::IsNullOrWhiteSpace($n)) { $n = "Unnamed" }
                if ($n.Length -gt 60) { $n = $n.Substring(0, 60) + "..." }

                $type = $c.ControlType.ProgrammaticName.Replace('ControlType.', '')

                $centerX = [int]($r.X + ($r.Width / 2))
                $centerY = [int]($r.Y + ($r.Height / 2))

                $indent = '  ' * $depth
                $null = $sb.AppendLine("$indent[$type] `"$n`" center=($centerX, $centerY)")
            } catch {}
        }

        $script:total = 0
        function Walk($el, $depth) {
            if ($script:total -gt 1000 -or $depth -gt $MaxDepth) { return }
            Fmt $el $depth
            $script:total++
            if ($depth -ge $MaxDepth) { return }

            $kids = $null
            try {
                $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
            } catch {
                $kids = $null
            }

            if ($kids) {
                $cap = 0
                foreach ($k in $kids) {
                    if ($cap -ge 100) { break }
                    Walk $k ($depth + 1)
                    $cap++
                }
            }
        }

        Walk $root 0
        Write-Output $sb.ToString()
    }
}
