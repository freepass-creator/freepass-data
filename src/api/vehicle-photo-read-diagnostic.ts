import { PHOTO_READ_FAILURE_PHASES, PHOTO_READ_FAILURE_REASONS,
  type VehiclePhotoReadFailure, type VehiclePhotoReadFailureObserver } from '../domain/consumer-output-contract.js';

export type VehiclePhotoReadDiagnostic = Readonly<VehiclePhotoReadFailure & { event: 'vehicle_photo_read_failure' }>;
type Sink = (diagnostic: VehiclePhotoReadDiagnostic) => void | Promise<void>;

/** Copy only own data values. Never traverse errors, identifiers or caller metadata. */
export function serializeVehiclePhotoReadFailure(input: unknown): VehiclePhotoReadDiagnostic | undefined {
  try {
    if (!input || typeof input !== 'object') return undefined;
    const value = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    };
    const operation = value('operation'), phase = value('phase'), reason = value('reason');
    const elapsedMs = value('elapsedMs'), phaseElapsedMs = value('phaseElapsedMs');
    if (operation !== 'INDEXED' && operation !== 'MANIFEST') return undefined;
    if (!(PHOTO_READ_FAILURE_PHASES as readonly unknown[]).includes(phase)
      || !(PHOTO_READ_FAILURE_REASONS as readonly unknown[]).includes(reason)) return undefined;
    const timing = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 300000;
    if (!timing(elapsedMs) || !timing(phaseElapsedMs)) return undefined;
    return Object.freeze({ event: 'vehicle_photo_read_failure', operation,
      phase: phase as VehiclePhotoReadFailure['phase'], reason: reason as VehiclePhotoReadFailure['reason'], elapsedMs, phaseElapsedMs });
  } catch { return undefined; }
}

/** Best-effort observation; sink failure cannot replace the original reader result. */
export function createVehiclePhotoReadFailureObserver(
  sink: Sink = diagnostic => { console.log(JSON.stringify(diagnostic)); },
): VehiclePhotoReadFailureObserver {
  return failure => {
    try {
      const diagnostic = serializeVehiclePhotoReadFailure(failure);
      if (!diagnostic) return;
      const result = sink(diagnostic);
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch { /* Preserve the original reader error or false revalidation result. */ }
  };
}
