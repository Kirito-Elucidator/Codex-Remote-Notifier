import * as vscode from 'vscode';

import {
  assertMatchingPresentationReceipt,
  AttentionPresentationPort,
  COMMAND_EXCHANGE_PRESENTATION,
  createCodexReturnTarget,
  parseCodexReturnTarget,
  parsePresentationExchange,
  parsePresentationReceipt,
  PresentationExchange,
  PresentationReceipt,
  PresentationRecord,
} from 'remote-notifier-shared';

export type PresentationCommandExecutor = (
  command: string,
  input: PresentationExchange,
) => Promise<unknown>;

export class PresentationCommandBridge implements AttentionPresentationPort {
  constructor(
    private readonly execute: PresentationCommandExecutor = async (command, input) =>
      vscode.commands.executeCommand(command, input),
    private readonly originCommand?: string,
  ) {}

  async exchange(input: PresentationExchange): Promise<PresentationReceipt> {
    const exchange = this.bindOrigin(parsePresentationExchange(input));
    const result = await this.execute(COMMAND_EXCHANGE_PRESENTATION, exchange);
    let receipt: PresentationReceipt;
    try {
      receipt = parsePresentationReceipt(result);
    } catch (error) {
      if (result === undefined) {
        throw new Error('Main presentation command returned no receipt', { cause: error });
      }
      throw error;
    }
    assertMatchingPresentationReceipt(exchange, receipt);
    return receipt;
  }

  private bindOrigin(exchange: PresentationExchange): PresentationExchange {
    if (!this.originCommand) return exchange;
    const bind = (record: PresentationRecord): PresentationRecord => {
      const target = parseCodexReturnTarget(record.returnTarget);
      return target
        ? {
            ...record,
            returnTarget: createCodexReturnTarget({ ...target, originCommand: this.originCommand }),
          }
        : record;
    };
    return exchange.kind === 'reconcile'
      ? { ...exchange, records: exchange.records.map(bind) }
      : {
          ...exchange,
          mutations: exchange.mutations.map((mutation) =>
            mutation.kind === 'withdraw'
              ? mutation
              : { ...mutation, record: bind(mutation.record) },
          ),
        };
  }
}
