import { describe, expect, it } from 'vitest';
import { adminViewAuthDecision } from '../src/api/admin-view-auth.js';

describe('Admin Catalog service auth',()=>{
  it('fails closed in production when no service token is bound',()=>{
    expect(adminViewAuthDecision({NODE_ENV:'production'},undefined)).toEqual({
      ok:false,status:503,code:'ADMIN_VIEW_AUTH_NOT_BOUND',
    });
  });

  it('rejects wrong bearer token when one is configured',()=>{
    expect(adminViewAuthDecision(
      {NODE_ENV:'production',FREEPASS_DATA_ADMIN_VIEW_TOKEN:'secret'},
      'Bearer wrong',
    )).toEqual({ok:false,status:401,code:'UNAUTHORIZED'});
  });

  it('accepts the configured bearer token',()=>{
    expect(adminViewAuthDecision(
      {NODE_ENV:'production',FREEPASS_DATA_ADMIN_VIEW_TOKEN:'secret'},
      'Bearer secret',
    )).toEqual({ok:true});
  });

  it('allows credential-free local development only when no token is configured',()=>{
    expect(adminViewAuthDecision({NODE_ENV:'development'},undefined)).toEqual({ok:true});
  });
});
