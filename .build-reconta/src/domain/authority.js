export class AuthorityDeniedError extends Error {
    aggregate;
    fieldPath;
    command;
    actorId;
    reason;
    code = 'AUTHORITY_DENIED';
    constructor(aggregate, fieldPath, command, actorId, reason) {
        super(`Authority denied for ${aggregate}.${fieldPath}: ${reason}`);
        this.aggregate = aggregate;
        this.fieldPath = fieldPath;
        this.command = command;
        this.actorId = actorId;
        this.reason = reason;
    }
}
export const CATALOG_COMMAND_WRITERS = [
    {
        command: 'CREATE_MANUAL_CATALOG_ENTRY',
        allowedWriters: [
            { kind: 'USER' },
            {
                kind: 'SERVICE',
                ids: ['service:freepass-data', 'service:freepass-admin']
            }
        ]
    },
    {
        command: 'CANONICALIZE_CATALOG_CANDIDATE',
        allowedWriters: [
            { kind: 'USER' },
            {
                kind: 'SERVICE',
                ids: ['service:freepass-data', 'service:freepass-admin']
            }
        ]
    },
    {
        command: 'APPLY_REVIEWED_SOURCE_CHANGE',
        allowedWriters: [
            { kind: 'USER' },
            {
                kind: 'SERVICE',
                ids: ['service:freepass-data', 'service:freepass-admin']
            }
        ]
    }
];
export const CATALOG_FIELD_AUTHORITY = [
    {
        ruleId: 'catalog.offer.internal-economics.recompute.v1',
        domain: 'catalog', aggregate: 'offer', fieldPath: 'internalEconomicsTerms',
        semanticOwner: 'catalog-economics', allowedCommands: ['RECOMPUTE_OFFER_ECONOMICS'],
        allowedWriters: [{ kind: 'USER' }, { kind: 'SERVICE', ids: ['service:freepass-data'] }],
        approval: 'NONE', conflict: 'EXPECTED_REVISION', override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE', sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    },
    {
        ruleId: 'catalog.offer.price-term.monthly-rent.v1',
        domain: 'catalog',
        aggregate: 'offer',
        fieldPath: 'priceTerms.*.monthlyRent',
        semanticOwner: 'catalog-pricing',
        allowedCommands: ['UPDATE_OFFER_PRICE', 'APPLY_REVIEWED_SOURCE_CHANGE'],
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
    },
    {
        ruleId: 'catalog.offer.price-term.deposit-state.v1',
        domain: 'catalog',
        aggregate: 'offer',
        fieldPath: 'priceTerms.*.depositState',
        semanticOwner: 'catalog-pricing',
        allowedCommands: ['APPLY_REVIEWED_SOURCE_CHANGE'],
        allowedWriters: [
            { kind: 'USER' },
            { kind: 'SERVICE', ids: ['service:freepass-data', 'service:freepass-admin'] }
        ],
        approval: 'REQUIRED',
        conflict: 'EXPECTED_REVISION',
        override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE',
        sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    },
    {
        ruleId: 'catalog.offer.price-term.deposit.v1',
        domain: 'catalog',
        aggregate: 'offer',
        fieldPath: 'priceTerms.*.deposit',
        semanticOwner: 'catalog-pricing',
        allowedCommands: ['APPLY_REVIEWED_SOURCE_CHANGE'],
        allowedWriters: [
            { kind: 'USER' },
            { kind: 'SERVICE', ids: ['service:freepass-data', 'service:freepass-admin'] }
        ],
        approval: 'REQUIRED',
        conflict: 'EXPECTED_REVISION',
        override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE',
        sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    },
    {
        ruleId: 'catalog.offer.price-term-mileage-limit.v1',
        domain: 'catalog',
        aggregate: 'offer',
        fieldPath: 'priceTerms.*.mileageLimitKmPerYear',
        semanticOwner: 'catalog-pricing',
        allowedCommands: ['APPLY_REVIEWED_SOURCE_CHANGE'],
        allowedWriters: [
            { kind: 'USER' },
            { kind: 'SERVICE', ids: ['service:freepass-data', 'service:freepass-admin'] }
        ],
        approval: 'REQUIRED',
        conflict: 'EXPECTED_REVISION',
        override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE',
        sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    },
    {
        // F03 «이름 하나»: the shared VehicleModel 세부모델/세부트림 follow F03 through a reviewed rename only.
        ruleId: 'catalog.vehicle-model.sub-model.v1',
        domain: 'catalog',
        aggregate: 'vehicle_model',
        fieldPath: 'subModel',
        semanticOwner: 'catalog-vehicle',
        allowedCommands: ['RENAME_VEHICLE_MODEL'],
        allowedWriters: [{ kind: 'SERVICE', ids: ['service:freepass-data'] }],
        approval: 'REQUIRED', conflict: 'EXPECTED_REVISION', override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE', sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    },
    {
        ruleId: 'catalog.vehicle-model.trim.v1',
        domain: 'catalog',
        aggregate: 'vehicle_model',
        fieldPath: 'trim',
        semanticOwner: 'catalog-vehicle',
        allowedCommands: ['RENAME_VEHICLE_MODEL'],
        allowedWriters: [{ kind: 'SERVICE', ids: ['service:freepass-data'] }],
        approval: 'REQUIRED', conflict: 'EXPECTED_REVISION', override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE', sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    },
    {
        ruleId: 'catalog.product.source-status.v1',
        domain: 'catalog', aggregate: 'product', fieldPath: 'status',
        semanticOwner: 'catalog-vehicle',
        allowedCommands: ['APPLY_REVIEWED_SOURCE_CHANGE'],
        allowedWriters: [{ kind: 'SERVICE', ids: ['service:freepass-data'] }],
        approval: 'REQUIRED', conflict: 'EXPECTED_REVISION', override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE', sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    },
    {
        ruleId: 'catalog.vehicle-asset.source-status.v1',
        domain: 'catalog', aggregate: 'vehicle_asset', fieldPath: 'status',
        semanticOwner: 'catalog-vehicle',
        allowedCommands: ['APPLY_REVIEWED_SOURCE_CHANGE'],
        allowedWriters: [{ kind: 'SERVICE', ids: ['service:freepass-data'] }],
        approval: 'REQUIRED', conflict: 'EXPECTED_REVISION', override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE', sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    },
    {
        ruleId: 'catalog.vehicle-asset.source-facts.v1',
        domain: 'catalog',
        aggregate: 'vehicle_asset',
        fieldPath: 'sourceVehicleFacts',
        semanticOwner: 'catalog-vehicle',
        allowedCommands: ['APPLY_REVIEWED_SOURCE_CHANGE'],
        allowedWriters: [{ kind: 'SERVICE', ids: ['service:freepass-data'] }],
        approval: 'REQUIRED', conflict: 'EXPECTED_REVISION', override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE', sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    },
    {
        ruleId: 'catalog.vehicle-asset.odometer.v1',
        domain: 'catalog',
        aggregate: 'vehicle_asset',
        fieldPath: 'odometerKm',
        semanticOwner: 'catalog-vehicle',
        allowedCommands: ['APPLY_REVIEWED_SOURCE_CHANGE'],
        allowedWriters: [
            { kind: 'USER' },
            { kind: 'SERVICE', ids: ['service:freepass-data', 'service:freepass-admin'] }
        ],
        approval: 'REQUIRED',
        conflict: 'EXPECTED_REVISION',
        override: 'DISALLOWED',
        effectiveTime: 'IMMEDIATE',
        sourceRefresh: 'PRESERVE_CANONICAL_AND_REVIEW'
    }
];
function fieldMatches(rulePath, fieldPath) {
    const rule = rulePath.split('.');
    const actual = fieldPath.split('.');
    if (rule.length !== actual.length)
        return false;
    return rule.every((part, index) => part === '*' || part === actual[index]);
}
function allowedWriterMatches(allowedWriters, actor) {
    return allowedWriters.some((writer) => {
        if (writer.kind !== actor.kind)
            return false;
        if (writer.kind === 'USER')
            return true;
        return writer.ids.includes(actor.id);
    });
}
function writerMatches(rule, actor) {
    return allowedWriterMatches(rule.allowedWriters, actor);
}
export function assertCommandWriter(command, actor) {
    const rule = CATALOG_COMMAND_WRITERS.find((item) => item.command === command);
    if (!rule || !allowedWriterMatches(rule.allowedWriters, actor)) {
        throw new AuthorityDeniedError('catalog', '*', command, actor.id, rule ? 'actor is not an allowed command writer' : 'no command writer rule exists');
    }
    return rule;
}
export function resolveFieldAuthority(aggregate, fieldPath) {
    return CATALOG_FIELD_AUTHORITY.find((rule) => rule.aggregate === aggregate && fieldMatches(rule.fieldPath, fieldPath)) ?? null;
}
export function assertFieldAuthority(input) {
    const rule = resolveFieldAuthority(input.aggregate, input.fieldPath);
    if (!rule) {
        throw new AuthorityDeniedError(input.aggregate, input.fieldPath, input.command, input.actor.id, 'no field authority rule exists');
    }
    if (!rule.allowedCommands.includes(input.command)) {
        throw new AuthorityDeniedError(input.aggregate, input.fieldPath, input.command, input.actor.id, `command ${input.command} is not allowed by ${rule.ruleId}`);
    }
    if (!writerMatches(rule, input.actor)) {
        throw new AuthorityDeniedError(input.aggregate, input.fieldPath, input.command, input.actor.id, `actor is not an allowed writer for ${rule.ruleId}`);
    }
    return rule;
}
