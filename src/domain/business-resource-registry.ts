export type BusinessTarget = 'CORE' | 'SALES' | 'LEGACY';
export type BusinessBackend = 'FIRESTORE' | 'RTDB';

export type BusinessResource = {
  name: string;
  target: BusinessTarget;
  backend: BusinessBackend;
  collectionOrRoot: string;
  consumers: readonly string[];
  read: boolean;
  write: boolean;
  nestedUnder?: string;
};

const resources = [
  // Admin / ERP5 operational domains.
  { name: 'admin.contract', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'contract', consumers: ['freepass-admin'], read: true, write: true },
  { name: 'admin.contract-event', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'contract_event', consumers: ['freepass-admin'], read: true, write: true },
  { name: 'admin.settlement-row', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'settlement_rows', consumers: ['freepass-admin'], read: true, write: true },
  { name: 'admin.settlement-event', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'settlement_events', consumers: ['freepass-admin'], read: true, write: true },
  { name: 'admin.settlement-invoice', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'settlement_invoices', consumers: ['freepass-admin'], read: true, write: true },
  { name: 'admin.settlement-clawback', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'settlement_clawbacks', consumers: ['freepass-admin'], read: true, write: true },
  { name: 'admin.cash-event', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'settlement_cash_events', consumers: ['freepass-admin'], read: true, write: true },
  { name: 'admin.partner', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'partner', consumers: ['freepass-admin'], read: true, write: false },
  { name: 'admin.vehicle-master', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'vehicle_master', consumers: ['freepass-admin'], read: true, write: false },
  { name: 'admin.esign-session', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'esign_sessions', consumers: ['freepass-admin'], read: true, write: true },
  { name: 'admin.esign-private', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'esign_private', consumers: ['freepass-admin'], read: true, write: true },
  { name: 'admin.auth-user', target: 'LEGACY', backend: 'FIRESTORE', collectionOrRoot: 'user', consumers: ['freepass-admin'], read: true, write: false },

  // ERP compatibility domains. Catalog projection remains preferred for product/public reads.
  { name: 'erp.product', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'products', consumers: ['erp-com'], read: true, write: false },
  { name: 'erp.policy', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'policy', consumers: ['erp-com'], read: true, write: false },
  { name: 'erp.partner', target: 'CORE', backend: 'FIRESTORE', collectionOrRoot: 'partner', consumers: ['erp-com'], read: true, write: false },

  // Sales CRM. Subcollections never escape as raw collection paths.
  { name: 'sales.lead', target: 'SALES', backend: 'FIRESTORE', collectionOrRoot: 'leads', consumers: ['freepass-sales'], read: true, write: true },
  { name: 'sales.call', target: 'SALES', backend: 'FIRESTORE', collectionOrRoot: 'calls', consumers: ['freepass-sales'], read: true, write: true, nestedUnder: 'leads' },
  { name: 'sales.status-event', target: 'SALES', backend: 'FIRESTORE', collectionOrRoot: 'statusEvents', consumers: ['freepass-sales'], read: true, write: true, nestedUnder: 'leads' },
  { name: 'sales.config', target: 'SALES', backend: 'FIRESTORE', collectionOrRoot: 'config', consumers: ['freepass-sales'], read: true, write: false },
  { name: 'sales.user', target: 'SALES', backend: 'FIRESTORE', collectionOrRoot: 'users', consumers: ['freepass-sales'], read: true, write: true },
  { name: 'sales.automation-mail-run', target: 'SALES', backend: 'FIRESTORE', collectionOrRoot: 'automation_mail_runs', consumers: ['freepass-sales-intake'], read: true, write: true },
  { name: 'sales.automation-contact-sync', target: 'SALES', backend: 'FIRESTORE', collectionOrRoot: 'automation_contact_sync', consumers: ['freepass-sales-intake'], read: true, write: true },

  // Estimate legacy RTDB domains. These exist only to remove client RTDB credentials during migration.
  { name: 'estimate.quote-legacy', target: 'LEGACY', backend: 'RTDB', collectionOrRoot: 'welrix_quotes', consumers: ['freepass-estimate'], read: true, write: true },
  { name: 'estimate.contract-legacy', target: 'LEGACY', backend: 'RTDB', collectionOrRoot: 'welrix_contracts', consumers: ['freepass-estimate'], read: true, write: true },
  { name: 'estimate.chat-legacy', target: 'LEGACY', backend: 'RTDB', collectionOrRoot: 'welrix_chats', consumers: ['freepass-estimate'], read: true, write: true },
  { name: 'estimate.lead-legacy', target: 'LEGACY', backend: 'RTDB', collectionOrRoot: 'leads', consumers: ['freepass-estimate'], read: true, write: true },
  { name: 'estimate.user-legacy', target: 'LEGACY', backend: 'RTDB', collectionOrRoot: 'users', consumers: ['freepass-estimate'], read: true, write: false },
] as const satisfies readonly BusinessResource[];

export const BUSINESS_RESOURCES = resources;

export function resolveBusinessResource(
  consumerId: string,
  name: string,
  mode: 'READ' | 'WRITE'
): BusinessResource | null {
  const resource = resources.find((item) => item.name === name);
  if (!resource || !resource.consumers.includes(consumerId as never)) return null;
  if (mode === 'READ' && !resource.read) return null;
  if (mode === 'WRITE' && !resource.write) return null;
  return resource;
}

export function assertBusinessId(value: unknown, label = 'id'): string {
  const id = String(value ?? '').trim();
  if (!id || id.length > 240 || id.includes('/') || id === '.' || id === '..') {
    throw new Error(`INVALID_BUSINESS_${label.toUpperCase()}`);
  }
  return id;
}
