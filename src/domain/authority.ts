import type { ActorRef } from './catalog.js';

export type CatalogCommandType =
  | 'UPDATE_OFFER_PRICE';

export type AuthorityConflictPolicy =
  | 'EXPECTED_REVISION'
  | 'REVIEW_REQUIRED';

export type AuthorityApprovalPolicy =
  | 'NONE'
  | 'REQUIRED';

export type AuthorityOverridePolicy =
  | 'DISALLOWED'
  | 'APPROVED_OVERRIDE_ONLY';

export type AuthorityEffectiveTimePolicy =
  | 'IMMEDIATE'
  | 'EXPLICIT_EFFECTIVE_AT';

export type SourceRefreshPolicy =
  | 'PRESERVE_CANONICAL_AND_REVIEW'
  | 'SOURCE_REFRESH_ALLOWED'
  | 'SOURCE_REFRESH_BLOCKED';

export type AllowedWriter =
  | { kind: 'USER' }
  | { kind: 'SERVICE'; ids: readonly string[] };

export type FieldAuthorityRule = {
  ruleId: string;
  domain: 'catalog';
  aggregate: 'offer' | 'product' | 'vehicle_model' | 'vehicle_asset' | 'policy';
  fieldPath: string;
  semanticOwner: string;
  allowedCommands: readonly CatalogCommandType[];
  allowedWriters: readonly AllowedWriter[];
  approval: AuthorityApprovalPolicy;
  conflict: AuthorityConflictPolicy;
  override: AuthorityOverridePolicy;
  effectiveTime: AuthorityEffectiveTimePolicy;
  sourceRefresh: SourceRefreshPolicy;
};

export type AuthorityCheck = {
  aggregate: FieldAuthorityRule['aggregate'];
  fieldPath: string;
  command: CatalogCommandType;
  actor: ActorRef;
};

export class AuthorityDeniedError extends Error {
  readonly code = 'AUTHORITY_DENIED';

  constructor(
    readonly aggregate: string,
    readonly fieldPath: string,
    readonly command: string,
    readonly actorId: string,
    readonly reason: string
  ) {
    super(`Authority denied for ${aggregate}.${fieldPath}: ${reason}`);
  }
}

export const CATALOG_FIELD_AUTHORITY: readonly FieldAuthorityRule[] = [
  {
    ruleId: 'catalog.offer.price-term.monthly-rent.v1',
    domain: 'catalog',
    aggregate: 'offer',
    fieldPath: 'priceTerms.*.monthlyRent',
    semanticOwner: 'catalog-pricing',
    allowedCommands: ['UPDATE_OFFER_PRICE'],
    allowedWriters: [
      { kind: 'USER' },
      {
        kind: 'SERVICE',
        ids: ['service:freepass-data', 'service:freepass-admin']
      }
    ],
    approval: 'NONE',
    conflict: 'EXPECTED_REVISION',
    override: 'DISALLOWED',
    effectiveTime: 'IMMEDIATE',
    sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
  }
] as const;

function fieldMatches(rulePath: string, fieldPath: string) {
  const rule = rulePath.split('.');
  const actual = fieldPath.split('.');
  if (rule.length !== actual.length) return false;
  return rule.every((part, index) => part === '*' || part === actual[index]);
}

function writerMatches(rule: FieldAuthorityRule, actor: ActorRef) {
  return rule.allowedWriters.some((writer) => {
    if (writer.kind !== actor.kind) return false;
    if (writer.kind === 'USER') return true;
    return writer.ids.includes(actor.id);
  });
}

export function resolveFieldAuthority(
  aggregate: FieldAuthorityRule['aggregate'],
  fieldPath: string
): FieldAuthorityRule | null {
  return CATALOG_FIELD_AUTHORITY.find(
    (rule) => rule.aggregate === aggregate && fieldMatches(rule.fieldPath, fieldPath)
  ) ?? null;
}

export function assertFieldAuthority(input: AuthorityCheck): FieldAuthorityRule {
  const rule = resolveFieldAuthority(input.aggregate, input.fieldPath);
  if (!rule) {
    throw new AuthorityDeniedError(
      input.aggregate,
      input.fieldPath,
      input.command,
      input.actor.id,
      'no field authority rule exists'
    );
  }

  if (!rule.allowedCommands.includes(input.command)) {
    throw new AuthorityDeniedError(
      input.aggregate,
      input.fieldPath,
      input.command,
      input.actor.id,
      `command ${input.command} is not allowed by ${rule.ruleId}`
    );
  }

  if (!writerMatches(rule, input.actor)) {
    throw new AuthorityDeniedError(
      input.aggregate,
      input.fieldPath,
      input.command,
      input.actor.id,
      `actor is not an allowed writer for ${rule.ruleId}`
    );
  }

  return rule;
}
