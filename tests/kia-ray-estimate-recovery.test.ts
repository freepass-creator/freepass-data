import {describe,it,expect,vi} from 'vitest';
import {runKiaRayEstimateRecovery} from '../src/application/kia-ray-estimate-recovery.js';
function ports(){return {snapshot:vi.fn(),capture:vi.fn(),normalize:vi.fn(),savePlan:vi.fn(),loadPlan:vi.fn(),now:()=>new Date().toISOString(),projection:{getActive:vi.fn(),getManifest:vi.fn(),stage:vi.fn(),stageEvidence:vi.fn(),markReady:vi.fn(),activate:vi.fn()}}}
describe('bounded first-release recovery worker',()=>{
 it('never replaces another operating release and does not fetch or write before that decision',async()=>{const p=ports();p.projection.getActive.mockResolvedValue({releaseId:'other',data:[{productId:'other'}]});p.projection.getManifest.mockResolvedValue(null);await expect(runKiaRayEstimateRecovery(p as any,{mode:'restore'})).rejects.toThrow('ACTIVE_RELEASE_ALREADY_PRESENT');expect(p.capture).not.toHaveBeenCalled();expect(p.projection.activate).not.toHaveBeenCalled()});
 it('requires an exact reviewed digest before applying a persisted plan',async()=>{const p=ports();await expect(runKiaRayEstimateRecovery(p as any,{mode:'publish'})).rejects.toThrow('REVIEWED_PLAN_REQUIRED');p.loadPlan.mockResolvedValue({tampered:true});await expect(runKiaRayEstimateRecovery(p as any,{mode:'publish',planId:'plan',planDigest:'a'.repeat(64)})).rejects.toThrow('PLAN_DIGEST_MISMATCH');expect(p.projection.stage).not.toHaveBeenCalled()});
});
