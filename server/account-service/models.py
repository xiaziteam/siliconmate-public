"""账号服务 2.0 — 数据模型 (SQLite) + 安全原语
任务: todo_a200a3b30119 [P0] 2.0-A3
规格: docs/2.0-账号服务API规格.md; 认证骨架: docs/2.0-账号服务认证协议设计.md

实现注记(A3): 规格中 api_key_hash 列拆为两列落地——
  key_sha   = sha256(api_key) 用于等值快速查找(明文key不入库)
  key_enc   = Fernet(MASTER_KEY)(api_key) 用于HMAC验签时解密还原
两列均为密文形态, 满足规格§四"明文不落库"。
"""
import hashlib
import os
import secrets
import sqlite3
import time
from datetime import datetime, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

DB_PATH = os.environ.get("ACCOUNT_DB", "data/account.db")

ph = PasswordHasher()

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  account_id    TEXT PRIMARY KEY,
  account_name  TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  key_sha       TEXT UNIQUE NOT NULL,
  key_enc       TEXT NOT NULL,
  device_id     TEXT,
  status        TEXT DEFAULT 'active',
  fail_count    INTEGER DEFAULT 0,
  locked_until  REAL DEFAULT 0,
  created_at    TEXT,
  updated_at    TEXT,
  silicon_id    TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  account_id     TEXT REFERENCES accounts(account_id),
  access_token   TEXT NOT NULL,
  cookies_json   TEXT NOT NULL DEFAULT '{}',
  expires_at     TEXT NOT NULL,
  priority       INTEGER DEFAULT 1,
  status         TEXT DEFAULT 'active',
  last_heartbeat REAL DEFAULT 0,
  created_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_acc ON sessions(account_id, status, priority);
CREATE TABLE IF NOT EXISTS card_keys (
  card_no          TEXT PRIMARY KEY,
  card_secret_hash TEXT NOT NULL,
  plan             TEXT NOT NULL,
  quota_days       INTEGER,
  bound_account    TEXT,
  status           TEXT DEFAULT 'unused',
  used_at          TEXT,
  expires_at       TEXT,
  created_at       TEXT
);
CREATE TABLE IF NOT EXISTS activation_codes (
  code_id       TEXT PRIMARY KEY,
  code_hash     TEXT UNIQUE NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'basic',
  status        TEXT DEFAULT 'active',
  bound_device  TEXT,
  used_at       TEXT,
  expires_at    TEXT,
  note          TEXT,
  product       TEXT DEFAULT 'shell',
  bound_account TEXT,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_act_codes_hash ON activation_codes(code_hash);
CREATE TABLE IF NOT EXISTS tunnel_configs (
  config_id     TEXT PRIMARY KEY,
  plan          TEXT UNIQUE NOT NULL,
  server        TEXT NOT NULL,
  server_port   INTEGER NOT NULL DEFAULT 443,
  uuid          TEXT NOT NULL,
  flow          TEXT DEFAULT 'xtls-rprx-vision',
  server_name   TEXT DEFAULT 'www.cloudflare.com',
  public_key    TEXT NOT NULL,
  short_id      TEXT NOT NULL,
  route_domains TEXT NOT NULL,
  note          TEXT,
  updated_at    TEXT,
  silicon_id    TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS tunnel_secrets (
  session_id  TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  created_at  TEXT
);
CREATE TABLE IF NOT EXISTS quarantined_sessions (
  session_id     TEXT PRIMARY KEY,
  quarantined_at TEXT DEFAULT (datetime('now'))
);
"""

# ---- 心跳判死参数 (海龟协议五要素: 30s心跳 / 90s判死 / +5min dead) ----
HEARTBEAT_INTERVAL = 30
STALE_AFTER_SEC = 90
DEAD_AFTER_SEC = 300


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)


def hash_password(pw: str) -> str:
    return ph.hash(pw)


def verify_password(pw_hash: str, pw: str) -> bool:
    try:
        ph.verify(pw_hash, pw)
        return True
    except VerifyMismatchError:
        return False


def new_account_id() -> str:
    return "acc_" + secrets.token_hex(8)

def new_silicon_id() -> str:
    """生成硅侣号 SM-XXXX (4位大写字母+数字)"""
    import string
    chars = string.ascii_uppercase + string.digits
    return "SM-" + "".join(secrets.choice(chars) for _ in range(4))


def new_session_id() -> str:
    return "sess_" + secrets.token_hex(8)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def refresh_session_statuses(conn: sqlite3.Connection):
    """惰性巡检: >90s无心跳→stale; stale再超5min→dead。A5任务加后台巡检job。"""
    now = time.time()
    conn.execute(
        "UPDATE sessions SET status='stale' WHERE status='active' "
        "AND last_heartbeat>0 AND ?-last_heartbeat>?",
        (now, STALE_AFTER_SEC))
    conn.execute(
        "UPDATE sessions SET status='dead' WHERE status='stale' "
        "AND ?-last_heartbeat>?", (now, DEAD_AFTER_SEC))


# ======================== SMCP 好友+消息 表 ========================

SMCP_SCHEMA = """
CREATE TABLE IF NOT EXISTS smcp_friends (
  friend_id         TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  friend_user_id    TEXT NOT NULL,
  status            TEXT DEFAULT 'pending',
  granted_perms     TEXT DEFAULT '{}',
  received_perms    TEXT DEFAULT '{}',
  alias             TEXT,
  created_at        TEXT,
  updated_at        TEXT,
  UNIQUE(user_id, friend_user_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_user ON smcp_friends(user_id, status);
CREATE INDEX IF NOT EXISTS idx_friends_both ON smcp_friends(user_id, friend_user_id);

CREATE TABLE IF NOT EXISTS smcp_friend_requests (
  request_id        TEXT PRIMARY KEY,
  from_user_id      TEXT NOT NULL,
  to_user_id        TEXT NOT NULL,
  message           TEXT,
  proposed_perms    TEXT DEFAULT '{}',
  status            TEXT DEFAULT 'pending',
  created_at        TEXT,
  responded_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_freq_to ON smcp_friend_requests(to_user_id, status);

CREATE TABLE IF NOT EXISTS smcp_agents (
  agent_id          TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  role              TEXT NOT NULL,
  device            TEXT NOT NULL,
  capabilities      TEXT DEFAULT '[]',
  endpoint          TEXT,
  status            TEXT DEFAULT 'online',
  last_heartbeat    REAL DEFAULT 0,
  registered_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_agents_user ON smcp_agents(user_id, status);

CREATE TABLE IF NOT EXISTS smcp_messages (
  msg_id            TEXT PRIMARY KEY,
  from_agent        TEXT NOT NULL,
  to_agent          TEXT,
  to_user           TEXT,
  msg_type          TEXT NOT NULL,
  method            TEXT NOT NULL,
  params            TEXT DEFAULT '{}',
  timestamp         REAL NOT NULL,
  hmac              TEXT,
  delivered         INTEGER DEFAULT 0,
  created_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_msgs_to ON smcp_messages(to_agent, delivered);
CREATE INDEX IF NOT EXISTS idx_msgs_from ON smcp_messages(from_agent, timestamp);
CREATE INDEX IF NOT EXISTS idx_msgs_user ON smcp_messages(to_user, delivered);
"""
