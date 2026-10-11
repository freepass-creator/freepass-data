import type {
  PeriodFeeLedgerRow,
  PeriodFeeSnapshotRun,
  ProductChangeHistoryBaselineRow,
  ProductChangeHistoryRow,
} from '../domain/period-fee-ledger.js';

type Rec = Record<string, unknown>;

export type ExistingPeriodFeeDocument = { digest: string; data: Rec };

export type PeriodFeeLedgerApplyStore = {
  getLedgerDocument(documentKey: string): Promise<ExistingPeriodFeeDocument | null>;
  createLedgerDocument(documentKey: string, row: PeriodFeeLedgerRow, digest: string): Promise<void>;
  createProductChangeHistoryDocument(documentKey: string, row: ProductChangeHistoryRow | ProductChangeHistoryBaselineRow, digest: string): Promise<void>;
  getSnapshotRun(snapshotId: string): Promise<PeriodFeeSnapshotRun | null>;
  setSnapshotRun(snapshotId: string, run: PeriodFeeSnapshotRun): Promise<void>;
  readLedgerRows(snapshotId: string): Promise<PeriodFeeLedgerRow[]>;
  markSnapshotRunInactive(snapshotId: string): Promise<void>;
  deleteLedgerRows(snapshotId: string): Promise<number>;
};
