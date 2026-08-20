import type { SanitizedAttentionObservation } from 'remote-notifier-shared';

type AttentionRequestKind = Extract<
  SanitizedAttentionObservation,
  { kind: 'human-action-request' }
>['requestKind'];

export function codexAttentionRequestKind(method: unknown): AttentionRequestKind | undefined {
  switch (method) {
    case 'item/tool/requestUserInput':
      return 'input';
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return 'approval';
    case 'item/permissions/requestApproval':
      return 'permission';
    case 'mcpServer/elicitation/request':
      return 'elicitation';
    default:
      return undefined;
  }
}

export function isCodexAttentionRequestMethod(method: unknown): boolean {
  return codexAttentionRequestKind(method) !== undefined;
}
