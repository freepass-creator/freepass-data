import {describe,it,expect,vi} from 'vitest';
import {runKiaRayEstimateRecovery,reviewedKiaRayIdentity} from '../src/application/kia-ray-estimate-recovery.js';
function ports(){return {snapshot:vi.fn(),capture:vi.fn(),normalize:vi.fn(),savePlan:vi.fn(),loadPlan:vi.fn(),now:()=>new Date().toISOString(),projection:{getActive:vi.fn(),getManifest:vi.fn(),stage:vi.fn(),stageEvidence:vi.fn(),markReady:vi.fn(),activate:vi.fn()}}}
describe('bounded first-release recovery worker',()=>{
 it('never replaces another operating release and does not fetch or write before that decision',async()=>{const p=ports();p.projection.getActive.mockResolvedValue({releaseId:'other',data:[{productId:'other'}]});p.projection.getManifest.mockResolvedValue(null);await expect(runKiaRayEstimateRecovery(p as any,{mode:'restore'})).rejects.toThrow('ACTIVE_RELEASE_ALREADY_PRESENT');expect(p.capture).not.toHaveBeenCalled();expect(p.projection.activate).not.toHaveBeenCalled()});
 it('requires an exact reviewed digest before applying a persisted plan',async()=>{const p=ports();await expect(runKiaRayEstimateRecovery(p as any,{mode:'publish'})).rejects.toThrow('REVIEWED_PLAN_REQUIRED');p.loadPlan.mockResolvedValue({tampered:true});await expect(runKiaRayEstimateRecovery(p as any,{mode:'publish',planId:'plan',planDigest:'a'.repeat(64)})).rejects.toThrow('PLAN_DIGEST_MISMATCH');expect(p.projection.stage).not.toHaveBeenCalled()});
});

import {KIA_RAY_REVIEWED_BINDINGS}from'../src/domain/kia-ray-recovery-preset.js';
describe('actual V1 Ray parent references',()=>{
 const binding=KIA_RAY_REVIEWED_BINDINGS[0];
 const master={id:'mf-002.md-058.sm-tam',data:{maker:'기아',model:'레이',sub_model:'더 뉴 기아 레이 TAM'},updateTime:null};
 const trim={id:binding.trimRowKey,data:{...master.data,master_id:master.id,trim_row_key:binding.trimRowKey,trim:'프레스티지',seats:5,engine_cc:998,turbo:false,powertrain_seq:1,model_year_start:'2027'},updateTime:null};
 it('uses stored parent ID despite a different permanent trim namespace',()=>{
  const ids=reviewedKiaRayIdentity(master,trim,binding);expect(ids.masterId).toBe(master.id);expect(ids.powertrainId).toBe(binding.trimRowKey.replace(/::t\d+$/,''));expect(ids.modelYearId).toBe(master.id+'::model-year:2027');expect(binding.trimRowKey.startsWith(master.id+'::')).toBe(false);
 });
 it('still rejects wrong parents, changed physical facts and retired records',()=>{
  for(const patch of [{master_id:'guessed-parent'},{seats:2},{engine_cc:1197},{turbo:true},{powertrain_seq:2},{model_year_start:'2026'},{retired:true}])expect(()=>reviewedKiaRayIdentity(master,{...trim,data:{...trim.data,...patch}},binding)).toThrow();
 });
});
