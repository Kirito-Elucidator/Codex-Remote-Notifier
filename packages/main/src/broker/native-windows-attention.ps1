$ErrorActionPreference = 'Stop'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.NotificationData, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:RN_NATIVE_APP_ID)

switch ($env:RN_NATIVE_OPERATION) {
    'show' {
        $document = New-Object Windows.Data.Xml.Dom.XmlDocument
        $document.LoadXml($env:RN_NATIVE_XML)
        $toast = [Windows.UI.Notifications.ToastNotification]::new($document)
        $toast.Tag = $env:RN_NATIVE_TAG
        $toast.Group = $env:RN_NATIVE_GROUP
        $data = [Windows.UI.Notifications.NotificationData]::new()
        $data.Values['title'] = $env:RN_NATIVE_TITLE
        $data.Values['body'] = $env:RN_NATIVE_BODY
        $data.SequenceNumber = 0
        $toast.Data = $data
        $notifier.Show($toast)
    }
    'update' {
        if (-not ($notifier.PSObject.Methods.Name -contains 'Update')) {
            Write-Output 'RN_UPDATE:Unsupported'
            break
        }
        $data = [Windows.UI.Notifications.NotificationData]::new()
        $data.Values['title'] = $env:RN_NATIVE_TITLE
        $data.Values['body'] = $env:RN_NATIVE_BODY
        $data.SequenceNumber = 0
        $result = $notifier.Update($data, $env:RN_NATIVE_TAG, $env:RN_NATIVE_GROUP)
        Write-Output "RN_UPDATE:$result"
    }
    'remove' {
        $history = [Windows.UI.Notifications.ToastNotificationManager]::History
        $history.Remove($env:RN_NATIVE_TAG, $env:RN_NATIVE_GROUP, $env:RN_NATIVE_APP_ID)
    }
    default {
        throw 'Unsupported native notification operation'
    }
}
