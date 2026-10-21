-- 20261021000000_claim_invite_lock_target_agent.sql: a credential rotation
-- locks the target agent row before deciding reuse-or-mint.
--
-- The race itself needs two sessions, which pgTAP cannot open; it was proven
-- against a fresh database by holding one claim's transaction open while a
-- second claimed (without the lock: 2 accounts minted, 1 orphaned; with it: 1
-- and 0). What this file pins is the lock surviving the next carry-forward of
-- the function body, since every later migration copies it verbatim.
begin;

select plan(2);

select ok(
  pg_get_functiondef('amux.claim_team_invite_legacy(text)'::regprocedure)
    ~* 'select\s+user_id\s+into\s+v_old_user\s+from\s+amux\.actors\s+where\s+id\s*=\s*v_invite\.target_actor_id\s+for\s+update',
  'claim_team_invite_legacy reads the target agent''s account under FOR UPDATE'
);

-- The lock only helps if the live entry point reaches it: belayo once ran a
-- pre-wrapper claim_team_invite body that never called the legacy function.
select ok(
  pg_get_functiondef('amux.claim_team_invite(text)'::regprocedure)
    ~* 'from\s+amux\.claim_team_invite_legacy\(p_token\)',
  'claim_team_invite delegates to claim_team_invite_legacy'
);

select * from finish();
rollback;
