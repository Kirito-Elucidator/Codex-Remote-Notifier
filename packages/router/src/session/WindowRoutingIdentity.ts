import { createHash, randomBytes } from 'crypto';

import * as vscode from 'vscode';

export async function resolveWindowRoutingId(
  context: vscode.ExtensionContext,
  log?: vscode.OutputChannel,
): Promise<string> {
  const raw = `${vscode.env.uriScheme}://ddyndo.remote-notifier-codex/window`;
  try {
    const external = (await vscode.env.asExternalUri(vscode.Uri.parse(raw))).toString();
    if (external === raw) throw new Error('Host returned an unbound window URI');
    // Treat the host-generated URI as opaque; no private window IDs or telemetry session IDs.
    return createHash('sha256')
      .update(
        JSON.stringify([
          external,
          vscode.env.machineId,
          context.globalStorageUri.fsPath,
          vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? '',
        ]),
      )
      .digest('hex')
      .slice(0, 32);
  } catch (error) {
    log?.appendLine(`[WindowRouting] Stable window identity unavailable: ${error}`);
    return randomBytes(16).toString('hex');
  }
}
