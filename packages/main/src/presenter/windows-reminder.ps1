$ErrorActionPreference = 'Stop'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

function Escape-Xml([string] $Value) {
    return [Security.SecurityElement]::Escape($Value)
}

function Get-UserNotificationState {
    if (-not ('RemoteNotifier.NativeMethods' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace RemoteNotifier {
    public static class NativeMethods {
        [DllImport("shell32.dll")]
        public static extern int SHQueryUserNotificationState(out int state);
    }
}
'@
    }

    [int] $state = 0
    $result = [RemoteNotifier.NativeMethods]::SHQueryUserNotificationState([ref] $state)
    if ($result -ne 0) {
        throw "SHQueryUserNotificationState failed with HRESULT 0x$($result.ToString('X8'))"
    }
    return $state
}

$title = Escape-Xml $env:RN_REMINDER_TITLE
$message = Escape-Xml $env:RN_REMINDER_MESSAGE
$launchUri = Escape-Xml $env:RN_REMINDER_LAUNCH_URI
$appId = $env:RN_REMINDER_APP_ID
$scenario = 'reminder'

if ($env:RN_REMINDER_FULLSCREEN_URGENT -eq '1') {
    try {
        $notificationState = Get-UserNotificationState
        $windowsBuild = [Environment]::OSVersion.Version.Build
        $blockedStates = @(2, 3, 4)
        if ($blockedStates -contains $notificationState) {
            if ($windowsBuild -ge 22546) {
                $scenario = 'urgent'
            } else {
                Write-Output "Important notifications are unavailable on Windows build $windowsBuild; using reminder."
            }
        }
    } catch {
        Write-Output "Could not query full-screen notification state; using reminder. $($_.Exception.Message)"
    }
}

$imageXml = ''
if ($env:RN_REMINDER_ICON -and (Test-Path -LiteralPath $env:RN_REMINDER_ICON)) {
    $iconUri = Escape-Xml ([Uri]::new($env:RN_REMINDER_ICON).AbsoluteUri)
    $imageXml = "<image placement=`"appLogoOverride`" src=`"$iconUri`"/>"
}

$audioXml = ''
if ($env:RN_REMINDER_SILENT -eq '1') {
    $audioXml = '<audio silent="true"/>'
}

$xml = @"
<toast scenario="$scenario" duration="long" activationType="protocol" launch="$launchUri">
  <visual>
    <binding template="ToastGeneric">
      $imageXml
      <text>$title</text>
      <text>$message</text>
    </binding>
  </visual>
  <actions>
    <action content="关闭" arguments="dismiss" activationType="system"/>
  </actions>
  $audioXml
</toast>
"@

$document = New-Object Windows.Data.Xml.Dom.XmlDocument
$document.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($document)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$notifier.Show($toast)
