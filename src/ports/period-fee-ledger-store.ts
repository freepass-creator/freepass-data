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
  getSnapshotRun(runId: string): Promise<PeriodFeeSnapshotRun | null>;
  getActiveSnapshotRun(snapshotId: string): Promise<PeriodFeeSnapshotRun | null>;
  getLatestSupersededSnapshotRun(snapshotId: string, excludeRunId: string): Promise<PeriodFeeSnapshotRun | null>;
  setSnapshotRun(runId: string, run: PeriodFeeSnapshotRun): Promise<void>;
  activateSnapshotRun(runId: string, run: PeriodFeeSnapshotRun, previousActiveRunId: string | null): Promise<void>;
  restoreSnapshotRunActive(runId: string, expectedPlanDigest: string): Promise<void>;
  readLedgerRows(snapshotId: string, runId: string): Promise<PeriodFeeLedgerRow[]>;
  markSnapshotRunInactive(runId: string): Promise<void>;
  deleteLedgerRowsByDigest(documentDigests: Array<{ documentKey: string; digest: string }>): Promise<number>;
};
