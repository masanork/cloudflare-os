-- Dedicated RP database. Never point this binding at the Mikaki issuer's database.
CREATE TABLE mikaki_login (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE mikaki_session (
  token_hash TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sid TEXT NOT NULL,
  sub TEXT NOT NULL,
  auth_time INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  parent_expires_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  idle_timeout INTEGER NOT NULL
);
CREATE INDEX mikaki_login_expiry ON mikaki_login(expires_at);
CREATE INDEX mikaki_session_idle ON mikaki_session(idle_expires_at);
CREATE INDEX mikaki_session_parent ON mikaki_session(parent_expires_at);
CREATE INDEX mikaki_session_sid ON mikaki_session(issuer, client_id, sid);
CREATE TABLE mikaki_logout (
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sid TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(issuer, client_id, sid)
);
CREATE INDEX mikaki_logout_expiry ON mikaki_logout(expires_at);
