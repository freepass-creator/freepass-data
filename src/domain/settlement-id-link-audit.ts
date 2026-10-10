export type SettlementIdLinkRawValue = string | number | boolean | null | undefined;

export type SettlementIdLinkSettlementRow = {
  id: string;
  plate?: SettlementIdLinkRawValue;
  code?: SettlementIdLinkRawValue;
  supplierCode?: SettlementIdLinkRawValue;
  product?: SettlementIdLinkRawValue;
  sourceTab?: SettlementIdLinkRawValue;
  sourceRow?: SettlementIdLinkRawValue;
  contractNo?: SettlementIdLinkRawValue;
  contractId?: SettlementIdLinkRawValue;
  contractCode?: SettlementIdLinkRawValue;
  intakeRequestId?: SettlementIdLinkRawValue;
  sourceProductId?: SettlementIdLinkRawValue;
};

export type SettlementIdLinkContract = {
  id: string;
  car_number_snapshot?: SettlementIdLinkRawValue;
  contract_code?: SettlementIdLinkRawValue;
  product_code?: SettlementIdLinkRawValue;
  _deleted?: SettlementIdLinkRawValue;
  is_draft?: SettlementIdLinkRawValue;
  test?: SettlementIdLinkRawValue;
  is_test?: SettlementIdLinkRawValue;
  env?: SettlementIdLinkRawValue;
  type?: SettlementIdLinkRawValue;
  status?: SettlementIdLinkRawValue;
};

export type SettlementIdLinkProduct = {
  id: string;
  car_number?: SettlementIdLinkRawValue;
  product_code?: SettlementIdLinkRawValue;
};

export type SettlementIdLinkAuditSource = {
  settlementRows: readonly SettlementIdLinkSettlementRow[];
  contracts: readonly SettlementIdLinkContract[];
  products: readonly SettlementIdLinkProduct[];
};
