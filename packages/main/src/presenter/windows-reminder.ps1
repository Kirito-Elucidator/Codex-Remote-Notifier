$ErrorActionPreference = 'Stop'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

function Escape-Xml([string] $Value) {
    return [Security.SecurityElement]::Escape($Value)
}

$title = Escape-Xml $env:RN_REMINDER_TITLE
$message = Escape-Xml $env:RN_REMINDER_MESSAGE
$launchUri = Escape-Xml $env:RN_REMINDER_LAUNCH_URI
$appId = $env:RN_REMINDER_APP_ID

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
<toast scenario="reminder" duration="long" activationType="protocol" launch="$launchUri">
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
