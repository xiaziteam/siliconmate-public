"""账号服务 2.0 — FastAPI 主应用
任务: todo_a200a3b30119 [P0] 2.0-A3
规格: docs/2.0-账号服务API规格.md (A2交付, 老痴评审通过)
认证骨架: docs/2.0-账号服务认证协议设计.md (A1交付) — 海龟协议五要素
"""
import json
import os
import secrets
import string
import time
import uuid
from datetime import datetime
from contextlib import asynccontextmanager

import jwt as pyjwt
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import models
from models import (DEAD_AFTER_SEC, HEARTBEAT_INTERVAL, STALE_AFTER_SEC,
                    hash_password, new_account_id, new_session_id, new_silicon_id,
                    now_iso, refresh_session_statuses, sha256_hex)

def get_db():
    return models.get_db()

def init_db():
    return models.init_db()
from security import (AuthError, decrypt_api_key, encrypt_api_key,
                      new_api_key, verify_password, verify_request)

MASTER_KEY = os.environ.get("MASTER_KEY", "master-key-dev-only")
JWT_TTL_SEC = 15 * 60          # L2 下发通道短期 JWT (A1§二)
LOGIN_MAX_FAIL = 5             # A2§2.1 锁定策略
LOCKOUT_SEC = 15 * 60


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    import asyncio
    from inspector import inspector_loop
    stop = asyncio.Event()
    app.state.inspector_stop = stop
    task = asyncio.create_task(inspector_loop(stop))
    yield
    stop.set()
    task.cancel()


app = FastAPI(title="magic-chatgpt-account-service", version="1.0.0",
              lifespan=lifespan)


def ok(data=None):
    return {"ok": True, "data": data or {}}


def err(code: str, message: str, status: int = 400):
    return JSONResponse(status_code=status,
                        content={"ok": False, "error": code, "message": message})


@app.exception_handler(AuthError)
async def auth_error_handler(request: Request, exc: AuthError):
    return err(exc.code, exc.message, 401)


@app.get("/health")
async def health():
    from models import get_db as _gdb
    try:
        with _gdb() as conn:
            n = conn.execute("SELECT COUNT(*) c FROM accounts").fetchone()["c"]
        return {"ok": True, "service": "account-service", "accounts": n}
    except Exception as e:
        return JSONResponse(status_code=500,
                            content={"ok": False, "error": "ERR_DB", "message": str(e)})


# ============================== /auth/login ==============================
@app.post("/v1/auth/login")
async def auth_login(request: Request):
    body = await request.json()
    name = body.get("account_name", "")
    password = body.get("password", "")
    device_id = body.get("device_id", "")
    if not name or not password:
        return err("ERR_FORMAT", "account_name/password必填")

    with get_db() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE account_name=?",
                           (name,)).fetchone()
        if not row:
            return err("ERR_AUTH", "账号或密码错误", 401)
        now = time.time()
        if now < row["locked_until"]:
            return err("ERR_RATE_LIMIT", "账号锁定中,稍后重试", 429)
        if row["status"] == "disabled":
            return err("ERR_AUTH", "账号已禁用", 403)

        if not verify_password(row["password_hash"], password):
            fc = row["fail_count"] + 1
            locked_until = now + LOCKOUT_SEC if fc >= LOGIN_MAX_FAIL else 0
            conn.execute(
                "UPDATE accounts SET fail_count=?,locked_until=?,updated_at=? WHERE account_id=?",
                (fc, locked_until, now_iso(), row["account_id"]))
            return err("ERR_AUTH", "账号或密码错误", 401)

        conn.execute(
            "UPDATE accounts SET fail_count=0,device_id=?,updated_at=? WHERE account_id=?",
            (device_id or row["device_id"], now_iso(), row["account_id"]))
        api_key = decrypt_api_key(row["key_enc"])
        # Check if account has an activation code bound
        activated = False
        act_plan = None
        tunnel = None
        act_row = conn.execute(
            "SELECT plan FROM activation_codes WHERE bound_account=? AND status='used' LIMIT 1",
            (row["account_id"],)).fetchone()
        if act_row:
            activated = True
            act_plan = act_row["plan"]
            tc = conn.execute(
                "SELECT server,server_port,uuid,flow,server_name,public_key,short_id,route_domains"
                " FROM tunnel_configs WHERE plan=?", (act_plan,)).fetchone()
            if tc:
                tunnel = {
                    "server": tc["server"], "server_port": tc["server_port"],
                    "uuid": tc["uuid"], "flow": tc["flow"],
                    "server_name": tc["server_name"], "public_key": tc["public_key"],
                    "short_id": tc["short_id"],
                    "route_domains": json.loads(tc["route_domains"]),
                }
        return ok({"account_id": row["account_id"], "api_key": api_key,
                   "expires_at": None, "activated": activated,
                   "plan": act_plan, "tunnel": tunnel,
                   "silicon_id": row["silicon_id"] if "silicon_id" in row.keys() else None})




# ============================== /auth/register ==============================
@app.post("/v1/auth/register")
async def auth_register(request: Request):
    body = await request.json()
    name = body.get("account_name", "").strip()
    password = body.get("password", "")
    device_id = body.get("device_id", "")
    if not name or not password:
        return err("ERR_FORMAT", "account_name/password必填")
    if len(name) < 3 or len(name) > 20:
        return err("ERR_FORMAT", "账号名须3-20字符")
    if len(password) < 6:
        return err("ERR_FORMAT", "密码至少6字符")

    with get_db() as conn:
        if conn.execute("SELECT 1 FROM accounts WHERE account_name=?", (name,)).fetchone():
            return err("ERR_FORMAT", "账号名已存在")
        aid = new_account_id()
        sid = new_silicon_id()
        key = new_api_key()
        # 确保silicon_id唯一（极低概率碰撞，重试即可）
        for _ in range(10):
            if not conn.execute("SELECT 1 FROM accounts WHERE silicon_id=?", (sid,)).fetchone():
                break
            sid = new_silicon_id()
        conn.execute(
            "INSERT INTO accounts(account_id,account_name,password_hash,key_sha,key_enc,"
            "device_id,created_at,updated_at,silicon_id) VALUES(?,?,?,?,?,?,?,?,?)",
            (aid, name, hash_password(password), sha256_hex(key),
             encrypt_api_key(key), device_id, now_iso(), now_iso(), sid))
    return ok({"account_id": aid, "silicon_id": sid, "api_key": key, "expires_at": None})

# ======================= HMAC 认证依赖 =======================
async def require_auth(request: Request):
    """X-API-Key 等值查库 + HMAC 签名校验。返回账号行。"""
    raw_key = request.headers.get("x-api-key", "")
    if not raw_key:
        raise AuthError("ERR_AUTH", "缺少 X-API-Key")
    with get_db() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE key_sha=?",
                           (sha256_hex(raw_key),)).fetchone()
        if not row:
            raise AuthError("ERR_AUTH", "api_key无效")
        if row["status"] != "active":
            raise AuthError("ERR_AUTH", f"账号状态{row['status']}", 403)
        verify_request(request.headers, await request.body(),
                       request.method, request.url.path, row["key_enc"])
        refresh_session_statuses(conn)
        return row


# ============================ /session/fetch ============================
def make_downstream_jwt(account_id: str, session_id: str) -> str:
    payload = {"acc": account_id, "ses": session_id,
               "exp": int(time.time()) + JWT_TTL_SEC}
    return pyjwt.encode(payload, MASTER_KEY, algorithm="HS256")


@app.post("/v1/session/fetch")
async def session_fetch(request: Request):
    account = await require_auth(request)
    aid = (await request.json()).get("account_id", "")
    if aid and aid != account["account_id"]:
        return err("ERR_AUTH", "account_id不匹配", 403)

    with get_db() as conn:
        sess = conn.execute(
            "SELECT * FROM sessions WHERE account_id=? AND status='active' "
            "ORDER BY priority ASC, created_at DESC LIMIT 1",
            (account["account_id"],)).fetchone()
        if not sess:
            return err("ERR_NOT_FOUND", "无可用session", 404)

        tun = conn.execute(
            "SELECT config_json FROM tunnel_secrets WHERE session_id=?",
            (sess["session_id"],)).fetchone()
        tunnel_config = json.loads(tun["config_json"]) if tun else None
        if tun:  # 用后即焚 (A4铁律: 隧道凭证一次性下发不入库)
            conn.execute("DELETE FROM tunnel_secrets WHERE session_id=?",
                         (sess["session_id"],))

        return ok({
            "chatgpt_session": {
                "access_token": sess["access_token"],
                "expires": sess["expires_at"],
                "cookies": json.loads(sess["cookies_json"]),
                "downstream_jwt": make_downstream_jwt(
                    account["account_id"], sess["session_id"]),
            },
            "tunnel_config": tunnel_config,
            "session_id": sess["session_id"],
            "heartbeat_url": "/v1/session/heartbeat",
            "heartbeat_interval_sec": HEARTBEAT_INTERVAL,
        })


# ========================== /session/heartbeat ==========================
@app.post("/v1/session/heartbeat")
async def session_heartbeat(request: Request):
    account = await require_auth(request)
    sid = (await request.json()).get("session_id", "")
    with get_db() as conn:
        row = conn.execute(
            "SELECT status FROM sessions WHERE session_id=? AND account_id=?",
            (sid, account["account_id"])).fetchone()
        if not row:
            return err("ERR_NOT_FOUND", "session不存在", 404)
        conn.execute("UPDATE sessions SET last_heartbeat=? WHERE session_id=?",
                     (time.time(), sid))
        return ok({"status": "alive" if row["status"] == "active" else row["status"],
                   "next_beat_sec": HEARTBEAT_INTERVAL})




# ============================== /account/activate ==============================
@app.post("/v1/account/activate")
async def account_activate(request: Request):
    account = await require_auth(request)
    body = await request.json()
    code = body.get("code", "").strip().upper()
    product = body.get("product", "siliconmate")
    if not code:
        return err("ERR_FORMAT", "激活码必填")
    code_hash = sha256_hex(code)
    with get_db() as conn:
        row = conn.execute(
            "SELECT code_id,plan,product,status,expires_at FROM activation_codes WHERE code_hash=?",
            (code_hash,)).fetchone()
        if not row:
            return err("ERR_INVALID", "激活码无效", 401)
        if row["product"] != product:
            return err("ERR_WRONG_PRODUCT", "此激活码不适用于当前产品", 401)
        if row["status"] != "active":
            return err("ERR_INVALID", "激活码已" + row["status"], 401)
        if row["expires_at"]:
            from datetime import datetime as _dt, timezone as _tz
            try:
                exp = _dt.fromisoformat(row["expires_at"]).astimezone(_tz.utc)
                if _dt.now(_tz.utc) > exp:
                    return err("ERR_EXPIRED", "激活码已过期", 401)
            except Exception:
                pass
        # Already activated?
        existing = conn.execute(
            "SELECT code_id FROM activation_codes WHERE bound_account=? AND status='used' LIMIT 1",
            (account["account_id"],)).fetchone()
        if existing:
            return err("ERR_ALREADY_ACTIVATED", "账号已激活", 409)
        # Bind code to account
        plan = row["plan"]
        conn.execute(
            "UPDATE activation_codes SET status='used',bound_account=?,bound_device=?,used_at=? WHERE code_id=?",
            (account["account_id"], account["device_id"] if account["device_id"] else "", now_iso(), row["code_id"]))
        tc = conn.execute(
            "SELECT server,server_port,uuid,flow,server_name,public_key,short_id,route_domains"
            " FROM tunnel_configs WHERE plan=?", (plan,)).fetchone()
        tunnel = None
        if tc:
            tunnel = {
                "server": tc["server"], "server_port": tc["server_port"],
                "uuid": tc["uuid"], "flow": tc["flow"],
                "server_name": tc["server_name"], "public_key": tc["public_key"],
                "short_id": tc["short_id"],
                "route_domains": json.loads(tc["route_domains"]),
            }
    return ok({"plan": plan, "code_id": row["code_id"], "tunnel": tunnel, "activated": True})

# ============================== admin 面 ==============================
def require_master(request: Request):
    import hmac as _h
    mk = request.headers.get("x-master-key", "")
    if not _h.compare_digest(mk, MASTER_KEY):
        raise AuthError("ERR_AUTH", "master_key无效")


@app.post("/v1/admin/account")
async def admin_account(request: Request):
    require_master(request)
    body = await request.json()
    action = body.get("action", "create")
    with get_db() as conn:
        if action == "create":
            name = body.get("account_name", "")
            pw = body.get("password", "")
            if not name or not pw:
                return err("ERR_FORMAT", "account_name/password必填")
            if conn.execute("SELECT 1 FROM accounts WHERE account_name=?", (name,)).fetchone():
                return err("ERR_FORMAT", "账号名已存在")
            aid = new_account_id()
            key = new_api_key()
            conn.execute(
                "INSERT INTO accounts(account_id,account_name,password_hash,key_sha,key_enc,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (aid, name, hash_password(pw), sha256_hex(key),
                 encrypt_api_key(key), now_iso(), now_iso()))
            return ok({"account_id": aid, "api_key": key})
        if action == "list":
            rows = conn.execute(
                "SELECT account_id,account_name,status,created_at FROM accounts").fetchall()
            return ok({"accounts": [dict(r) for r in rows]})
        return err("ERR_FORMAT", f"未知action:{action}")


@app.post("/v1/admin/bind")
async def admin_bind(request: Request):
    require_master(request)
    body = await request.json()
    aid = body.get("account_id", "")
    cs = body.get("chatgpt_session") or {}
    priority = int(body.get("priority", 1))
    tunnel_config = body.get("tunnel_config")  # 有则入一次性下发队列(A4联调用)
    if not aid or not cs.get("access_token"):
        return err("ERR_FORMAT", "account_id/chatgpt_session.access_token必填")
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM accounts WHERE account_id=?", (aid,)).fetchone():
            return err("ERR_NOT_FOUND", "账号不存在", 404)
        sid = new_session_id()
        conn.execute(
            "INSERT INTO sessions(session_id,account_id,access_token,cookies_json,"
            "expires_at,priority,status,last_heartbeat,created_at)"
            " VALUES(?,?,?,?,?,?,'active',?,?)",
            (sid, aid, cs["access_token"], json.dumps(cs.get("cookies") or {}),
             cs.get("expires") or now_iso(), priority,
             time.time(), now_iso()))
        if tunnel_config:
            conn.execute(
                "INSERT OR REPLACE INTO tunnel_secrets(session_id,config_json,created_at)"
                " VALUES(?,?,?)", (sid, json.dumps(tunnel_config), now_iso()))
        return ok({"session_id": sid, "bound": True})


@app.post("/v1/admin/revoke")
async def admin_revoke(request: Request):
    require_master(request)
    body = await request.json()
    ttype = body.get("target_type", "")
    tid = body.get("target_id", "")
    with get_db() as conn:
        if ttype in ("api_key", "account"):
            conn.execute(
                "UPDATE accounts SET status='disabled',updated_at=? WHERE account_id=?",
                (now_iso(), tid))
            if ttype == "account":
                conn.execute("DELETE FROM sessions WHERE account_id=?", (tid,))
        elif ttype == "session":
            conn.execute("DELETE FROM sessions WHERE session_id=?", (tid,))
            conn.execute("DELETE FROM tunnel_secrets WHERE session_id=?", (tid,))
            conn.execute(
                "INSERT OR IGNORE INTO quarantined_sessions(session_id) VALUES(?)", (tid,))
        else:
            return err("ERR_FORMAT", "target_type须为api_key|session|account")
        return ok({"revoked": True})


# ========================== 激活码管理 ==========================
def _gen_code(product: str = "shell") -> str:
    chars = string.ascii_uppercase + string.digits
    prefix = "GL" if product == "siliconmate" else "XK"
    return prefix + "-" + "".join(secrets.choice(chars) for _ in range(3)) + "-" + \
           "".join(secrets.choice(chars) for _ in range(4))


@app.post("/v1/admin/activation/create")
async def admin_activation_create(request: Request):
    require_master(request)
    body = await request.json()
    plan = body.get("plan", "basic")
    if plan not in ("basic", "pro"):
        return err("ERR_FORMAT", "plan须为basic|pro")
    product = body.get("product", "shell")
    if product not in ("shell", "siliconmate"):
        return err("ERR_FORMAT", "product须为shell|siliconmate")
    note = body.get("note", "")
    code = _gen_code(product)
    code_hash = sha256_hex(code)
    code_id = "act_" + secrets.token_hex(8)
    with get_db() as conn:
        conn.execute(
            "INSERT INTO activation_codes(code_id,code_hash,plan,product,note,created_at)"
            " VALUES(?,?,?,?,?,?)",
            (code_id, code_hash, plan, product, note, now_iso()))
    return ok({"code": code, "code_id": code_id, "plan": plan, "product": product})


@app.post("/v1/admin/activation/list")
async def admin_activation_list(request: Request):
    require_master(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT code_id,plan,product,status,bound_device,bound_account,used_at,expires_at,note,created_at"
            " FROM activation_codes ORDER BY created_at DESC").fetchall()
    return ok({"codes": [dict(r) for r in rows]})


@app.post("/v1/admin/activation/revoke")
async def admin_activation_revoke(request: Request):
    require_master(request)
    body = await request.json()
    code_id = body.get("code_id", "")
    if not code_id:
        return err("ERR_FORMAT", "code_id必填")
    with get_db() as conn:
        row = conn.execute("SELECT status FROM activation_codes WHERE code_id=?",
                           (code_id,)).fetchone()
        if not row:
            return err("ERR_NOT_FOUND", "激活码不存在", 404)
        if row["status"] == "revoked":
            return err("ERR_FORMAT", "已吊销")
        conn.execute("UPDATE activation_codes SET status='revoked' WHERE code_id=?",
                     (code_id,))
    return ok({"revoked": True})


@app.post("/v1/admin/tunnel/set")
async def admin_tunnel_set(request: Request):
    require_master(request)
    body = await request.json()
    plan = body.get("plan", "")
    if plan not in ("basic", "pro"):
        return err("ERR_FORMAT", "plan须为basic|pro")
    server = body.get("server", "")
    server_port = body.get("server_port", 443)
    uuid = body.get("uuid", "")
    flow = body.get("flow", "xtls-rprx-vision")
    server_name = body.get("server_name", "www.cloudflare.com")
    public_key = body.get("public_key", "")
    short_id = body.get("short_id", "")
    route_domains = body.get("route_domains", [])
    note = body.get("note", "")
    if not server or not uuid or not public_key or not short_id or not route_domains:
        return err("ERR_FORMAT", "server/uuid/public_key/short_id/route_domains必填")
    config_id = "tc_" + secrets.token_hex(4)
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO tunnel_configs"
            "(config_id,plan,server,server_port,uuid,flow,server_name,public_key,short_id,route_domains,note,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (config_id, plan, server, server_port, uuid, flow, server_name,
             public_key, short_id, json.dumps(route_domains), note, now_iso()))
    return ok({"config_id": config_id, "plan": plan})


@app.post("/v1/admin/tunnel/list")
async def admin_tunnel_list(request: Request):
    require_master(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT config_id,plan,server,server_port,uuid,flow,server_name,"
            "public_key,short_id,note,updated_at FROM tunnel_configs").fetchall()
    return ok({"configs": [dict(r) for r in rows]})


@app.post("/v1/code/validate")
async def code_validate(request: Request):
    body = await request.json()
    code = body.get("code", "").strip().upper()
    product = body.get("product", "shell")
    if not code:
        return err("ERR_FORMAT", "激活码必填")
    code_hash = sha256_hex(code)
    with get_db() as conn:
        row = conn.execute(
            "SELECT code_id,plan,product,status,expires_at FROM activation_codes WHERE code_hash=?",
            (code_hash,)).fetchone()
        if not row:
            return err("ERR_INVALID", "激活码无效", 401)
        if row["product"] != product:
            return err("ERR_WRONG_PRODUCT", "此激活码不适用于当前产品", 401)
        if row["status"] != "active":
            return err("ERR_INVALID", "激活码已" + row["status"], 401)
        if row["expires_at"]:
            from datetime import datetime as _dt, timezone as _tz
            try:
                exp = _dt.fromisoformat(row["expires_at"]).astimezone(_tz.utc)
                if _dt.now(_tz.utc) > exp:
                    return err("ERR_EXPIRED", "激活码已过期", 401)
            except Exception:
                pass
        plan = row["plan"]
        device_id = body.get("device_id", "")
        if device_id and row["status"] == "active":
            conn.execute(
                "UPDATE activation_codes SET bound_device=?,used_at=?,status='used' WHERE code_id=?",
                (device_id, now_iso(), row["code_id"]))

        tc = conn.execute(
            "SELECT server,server_port,uuid,flow,server_name,public_key,short_id,route_domains"
            " FROM tunnel_configs WHERE plan=?", (plan,)).fetchone()
        tunnel = None
        if tc:
            tunnel = {
                "server": tc["server"],
                "server_port": tc["server_port"],
                "uuid": tc["uuid"],
                "flow": tc["flow"],
                "server_name": tc["server_name"],
                "public_key": tc["public_key"],
                "short_id": tc["short_id"],
                "route_domains": json.loads(tc["route_domains"]),
            }

        return ok({"plan": plan, "code_id": row["code_id"], "tunnel": tunnel})


# ==================== 闲鱼商单 · 救援审计（只读） ====================
# 2026-09-09 锅底：把闲鱼「电脑远程救援」的救援码账号并入虾壳管理后台。
#   目的 = 审计留痕（发码 → 兑换 → 买家同意 全链路可查），**不提供发码/吊销写操作**
#   ——铁律：判断与拍板归波迪，锅底不进执行链、不替波迪拍 revoke / 发码。
#   数据源：同机 rescue-auth 服务(:8455)的 SQLite，以只读方式挂载进来，本服务绝不写它。
import sqlite3 as _sqlite3

RESCUE_DB = os.environ.get("RESCUE_DB", "/srv/rescue/rescue_auth.db")
# 闲鱼三条链接对应的服务档位（与 seller_inbox 的 RESCUE_PLAN 对齐）
RESCUE_PLAN_LABEL = {"small": "9.9 引流", "std": "标准/40 补差", "pro": "100 大工程"}


def _rescue_conn():
    """只读打开救援库；文件不存在时返回 None（优雅降级，不影响账号服务主流程）。"""
    if not os.path.exists(RESCUE_DB):
        return None
    conn = _sqlite3.connect("file:%s?mode=ro" % RESCUE_DB, uri=True, timeout=5)
    conn.row_factory = _sqlite3.Row
    return conn


@app.post("/v1/admin/rescue/list")
async def admin_rescue_list(request: Request):
    require_master(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    limit = int(body.get("limit") or 200)
    limit = 1 if limit < 1 else (500 if limit > 500 else limit)
    status = (body.get("status") or "").strip()

    conn = _rescue_conn()
    if conn is None:
        return ok({"available": False, "codes": [], "stats": {},
                   "reason": "救援库未挂载或不存在: %s" % RESCUE_DB})
    try:
        q = ("SELECT code,service,order_id,buyer_id,plan,status,issued_at,"
             "redeemed_at,consent_at,expires_at,redeem_count,"
             "CASE WHEN COALESCE(api_key,'')<>'' THEN 1 ELSE 0 END AS has_key,"
             "CASE WHEN COALESCE(session_token,'')<>'' THEN 1 ELSE 0 END AS has_session"
             " FROM codes")
        args = []
        if status:
            q += " WHERE COALESCE(status,'')=?"
            args.append(status)
        q += " ORDER BY issued_at DESC LIMIT ?"
        args.append(limit)
        rows = conn.execute(q, args).fetchall()

        stats = {}
        for r in conn.execute(
                "SELECT COALESCE(status,'unknown') s, COUNT(*) c FROM codes GROUP BY s"):
            stats[r["s"]] = r["c"]
        total = sum(stats.values())
        today = conn.execute(
            "SELECT COUNT(*) c FROM codes WHERE date(issued_at)=date('now')").fetchone()["c"]
        # 真实授权 = 买家点过「同意」(consent_at 非空)，是合规三件套里的关键留痕
        consented = conn.execute(
            "SELECT COUNT(*) c FROM codes WHERE COALESCE(consent_at,'')<>''").fetchone()["c"]

        mtime = ""
        try:
            mtime = time.strftime("%Y-%m-%d %H:%M:%S",
                                  time.localtime(os.path.getmtime(RESCUE_DB)))
        except Exception:
            pass

        return ok({
            "available": True,
            "codes": [dict(r) for r in rows],
            "stats": {"total": total, "today": today, "consented": consented, **stats},
            "db_mtime": mtime,
            "plan_labels": RESCUE_PLAN_LABEL,
        })
    except Exception as e:
        return err("ERR_RESCUE_DB", "读救援库失败: %s" % e, 500)
    finally:
        conn.close()


RESCUE_HUNTER_SNAPSHOT = os.environ.get(
    "RESCUE_HUNTER_SNAPSHOT", "/srv/rescue/hunter_snapshot.json")


@app.post("/v1/admin/rescue/hunter")
async def admin_rescue_hunter(request: Request):
    """闲鱼猎手数据快照（只读）。

    猎手真身在东京 VPS，2号通过 ssh 定时拉取快照写入 /srv/rescue/hunter_snapshot.json
    (见 /root/xianyu-rescue/hunter_pull.sh)。这里只做读取展示，不含任何抓取/写操作。
    """
    require_master(request)
    p = RESCUE_HUNTER_SNAPSHOT
    if not os.path.exists(p):
        return ok({"available": False, "reason": "猎手快照尚未生成: %s" % p})
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.loads(f.read() or "{}")
        try:
            age = time.time() - os.path.getmtime(p)
            data["_age_sec"] = int(age)
            data["_stale"] = bool(age > 7200)   # 超过 2 小时视为陈旧
        except Exception:
            pass

        # 附带：我方三条链接的在售状态（东京 guest_watch.py 免登录产出）
        try:
            gp = os.path.join(os.path.dirname(p), "guest_watch.json")
            if os.path.exists(gp):
                with open(gp, "r", encoding="utf-8") as gf:
                    data["our_items"] = json.loads(gf.read() or "{}")
        except Exception:
            pass

        return ok(data)
    except Exception as e:
        return err("ERR_HUNTER_SNAPSHOT", "读猎手快照失败: %s" % e, 500)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8710)


# ======================== SMCP v0.1 ========================

import json as _json

def _smcp_db():
    conn = get_db()
    conn.executescript(models.SMCP_SCHEMA)
    return conn

def _uid_from_req(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        try:
            payload = pyjwt.decode(auth[7:], MASTER_KEY, algorithms=["HS256"])
            return payload.get("account_id", "")
        except Exception:
            pass
    return request.headers.get("X-Account-Id", "")

@app.get("/v1/smcp/ping")
async def smcp_ping():
    return {"ok": True, "service": "smcp", "version": "0.1", "timestamp": time.time()}

@app.post("/v1/smcp/agent/register")
async def smcp_agent_register(request: Request):
    body = await request.json()
    user_id = _uid_from_req(request) or body.get("user_id", "")
    if not user_id:
        return err("AUTH", "need auth", 401)
    agent_id = body.get("agent_id", "A-" + user_id[:8] + "-" + body.get("role", "default"))
    role = body.get("role", "mobile")
    device = body.get("device", "android")
    capabilities = body.get("capabilities", [])
    endpoint = body.get("endpoint", "")
    with _smcp_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO smcp_agents (agent_id, user_id, role, device, capabilities, endpoint, status, last_heartbeat, registered_at) VALUES (?,?,?,?,?,?,?,'online',datetime('now'))",
            (agent_id, user_id, role, device, _json.dumps(capabilities), endpoint, time.time()))
    return ok({"agent_id": agent_id, "status": "online"})

@app.post("/v1/smcp/agent/list")
async def smcp_agent_list(request: Request):
    body = await request.json()
    user_id = _uid_from_req(request) or body.get("user_id", "")
    with _smcp_db() as conn:
        rows = conn.execute("SELECT agent_id, role, device, capabilities, endpoint, status FROM smcp_agents WHERE user_id=?", (user_id,)).fetchall()
    agents = []
    for r in rows:
        a = dict(r)
        a["capabilities"] = _json.loads(a.get("capabilities", "[]"))
        agents.append(a)
    return ok({"agents": agents})

@app.post("/v1/smcp/friend/request")
async def smcp_friend_request(request: Request):
    body = await request.json()
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    to_user = body.get("to_user_id", "")
    to_silicon_id = body.get("to_silicon_id", "")  # 支持硅侣号添加好友
    message = body.get("message", "")
    proposed_perms = body.get("permissions", {"agent_comm": True, "agent_delegate": False})
    # 硅侣号解析: SM-XXXX → account_id
    if to_silicon_id and not to_user:
        with get_db() as conn:
            found = conn.execute("SELECT account_id FROM accounts WHERE silicon_id=?", (to_silicon_id,)).fetchone()
            if not found:
                return err("NOT_FOUND", f"硅侣号 {to_silicon_id} 不存在")
            to_user = found["account_id"]
    if not to_user:
        return err("PARAM", "missing to_user_id or to_silicon_id")
    if user_id == to_user:
        return err("PARAM", "cannot friend yourself")
    with _smcp_db() as conn:
        existing = conn.execute("SELECT status FROM smcp_friends WHERE user_id=? AND friend_user_id=?", (user_id, to_user)).fetchone()
        if existing and existing["status"] == "accepted":
            return err("EXISTS", "already friends")
        request_id = "freq_" + secrets.token_hex(8)
        conn.execute("INSERT INTO smcp_friend_requests (request_id, from_user_id, to_user_id, message, proposed_perms, status, created_at) VALUES (?,?,?,?,?,'pending',datetime('now'))",
            (request_id, user_id, to_user, message, _json.dumps(proposed_perms)))
    return ok({"request_id": request_id})

@app.post("/v1/smcp/friend/accept")
async def smcp_friend_accept(request: Request):
    body = await request.json()
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    request_id = body.get("request_id", "")
    my_perms = body.get("permissions", {"agent_comm": True, "agent_delegate": False})
    with _smcp_db() as conn:
        req = conn.execute("SELECT from_user_id, proposed_perms FROM smcp_friend_requests WHERE request_id=? AND to_user_id=? AND status='pending'", (request_id, user_id)).fetchone()
        if not req:
            return err("NOT_FOUND", "request not found")
        from_user = req["from_user_id"]
        proposed = _json.loads(req["proposed_perms"])
        friend_id1 = "fr_" + secrets.token_hex(8)
        friend_id2 = "fr_" + secrets.token_hex(8)
        ts = now_iso()
        conn.execute("INSERT INTO smcp_friends (friend_id, user_id, friend_user_id, status, granted_perms, received_perms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (friend_id1, user_id, from_user, "accepted", _json.dumps(my_perms), _json.dumps(proposed), ts, ts))
        conn.execute("INSERT INTO smcp_friends (friend_id, user_id, friend_user_id, status, granted_perms, received_perms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (friend_id2, from_user, user_id, "accepted", _json.dumps(proposed), _json.dumps(my_perms), ts, ts))
        conn.execute("UPDATE smcp_friend_requests SET status='accepted', responded_at=datetime('now') WHERE request_id=?", (request_id,))
    return ok()

@app.post("/v1/smcp/friend/reject")
async def smcp_friend_reject(request: Request):
    """T027: 拒绝好友申请 — 置 status='rejected', 发起方不可重复申请同一目标"""
    body = await request.json()
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    request_id = body.get("request_id", "")
    if not request_id:
        return err("PARAM", "missing request_id")
    with _smcp_db() as conn:
        row = conn.execute("SELECT from_user_id FROM smcp_friend_requests WHERE request_id=? AND to_user_id=? AND status='pending'", (request_id, user_id)).fetchone()
        if not row:
            return err("NOT_FOUND", "request not found")
        conn.execute("UPDATE smcp_friend_requests SET status='rejected', responded_at=datetime('now') WHERE request_id=?", (request_id,))
    return ok()

@app.post("/v1/smcp/friend/list")
async def smcp_friend_list(request: Request):
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    with _smcp_db() as conn:
        rows = conn.execute("SELECT f.friend_id, f.friend_user_id, f.status, f.granted_perms, f.received_perms, f.alias, f.created_at, a.silicon_id, a.account_name, COALESCE(ag.status, 'offline') as agent_status, ag.last_heartbeat FROM smcp_friends f LEFT JOIN accounts a ON f.friend_user_id=a.account_id LEFT JOIN (SELECT user_id, status, last_heartbeat FROM smcp_agents WHERE status='online' GROUP BY user_id) ag ON f.friend_user_id=ag.user_id WHERE f.user_id=?", (user_id,)).fetchall()
        prows = conn.execute("SELECT r.request_id, r.from_user_id, r.message, r.proposed_perms, r.created_at, a.silicon_id AS from_silicon_id, a.account_name AS from_name FROM smcp_friend_requests r LEFT JOIN accounts a ON r.from_user_id=a.account_id WHERE r.to_user_id=? AND r.status='pending'", (user_id,)).fetchall()
    friends = []
    for r in rows:
        f = dict(r)
        f["granted_perms"] = _json.loads(f.get("granted_perms", "{}"))
        f["received_perms"] = _json.loads(f.get("received_perms", "{}"))
        friends.append(f)
    pending = []
    for p in prows:
        pr = dict(p)
        pr["proposed_perms"] = _json.loads(pr.get("proposed_perms", "{}"))
        pending.append(pr)
    return ok({"friends": friends, "pending_requests": pending})

@app.post("/v1/smcp/friend/setPermissions")
async def smcp_friend_set_permissions(request: Request):
    body = await request.json()
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    friend_user_id = body.get("user_id", "")
    permissions = body.get("permissions", {})
    if not friend_user_id:
        return err("PARAM", "missing user_id")
    with _smcp_db() as conn:
        row = conn.execute("SELECT friend_id FROM smcp_friends WHERE user_id=? AND friend_user_id=? AND status='accepted'", (user_id, friend_user_id)).fetchone()
        if not row:
            return err("NOT_FRIEND", "not friends")
        conn.execute("UPDATE smcp_friends SET granted_perms=?, updated_at=datetime('now') WHERE user_id=? AND friend_user_id=?", (_json.dumps(permissions), user_id, friend_user_id))
    return ok()

@app.post("/v1/smcp/friend/remove")
async def smcp_friend_remove(request: Request):
    body = await request.json()
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    friend_user_id = body.get("user_id", "")
    with _smcp_db() as conn:
        conn.execute("DELETE FROM smcp_friends WHERE user_id=? AND friend_user_id=?", (user_id, friend_user_id))
        conn.execute("DELETE FROM smcp_friends WHERE user_id=? AND friend_user_id=?", (friend_user_id, user_id))
    return ok()

@app.post("/v1/smcp/message/send")
async def smcp_message_send(request: Request):
    body = await request.json()
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    from_agent = body.get("from_agent", "")
    to_agent = body.get("to_agent", "")
    to_user = body.get("to_user", "")
    msg_type = body.get("type", "notify")
    method = body.get("method", "im.send")
    params = body.get("params", {})
    if to_user and to_user != user_id:
        with _smcp_db() as conn:
            friend = conn.execute("SELECT granted_perms FROM smcp_friends WHERE user_id=? AND friend_user_id=? AND status='accepted'", (user_id, to_user)).fetchone()
            if not friend:
                return err("NOT_FRIEND", "not friends", 403)
            perms = _json.loads(friend["granted_perms"])
            if not perms.get("agent_comm", False):
                return err("NO_COMM", "no agent_comm permission", 403)
            if method.startswith("delegate") and not perms.get("agent_delegate", False):
                return err("NO_DELEGATE", "no agent_delegate permission", 403)
    msg_id = "M-" + str(int(time.time())) + "-" + secrets.token_hex(4)
    with _smcp_db() as conn:
        conn.execute("INSERT INTO smcp_messages (msg_id, from_agent, to_agent, to_user, msg_type, method, params, timestamp, hmac, created_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
            (msg_id, from_agent, to_agent, to_user, msg_type, method, _json.dumps(params), time.time(), ""))
    return ok({"msg_id": msg_id})

@app.post("/v1/smcp/message/poll")
async def smcp_message_poll(request: Request):
    body = await request.json()
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    agent_id = body.get("agent_id", "")
    limit = body.get("limit", 50)
    with _smcp_db() as conn:
        rows = conn.execute("SELECT msg_id, from_agent, to_agent, to_user, msg_type, method, params, timestamp FROM smcp_messages WHERE (to_agent=? OR to_user=?) AND delivered=0 ORDER BY timestamp ASC LIMIT ?", (agent_id, user_id, limit)).fetchall()
        if rows:
            ids = [r["msg_id"] for r in rows]
            ph = ",".join("?" * len(ids))
            conn.execute("UPDATE smcp_messages SET delivered=1 WHERE msg_id IN (" + ph + ")", ids)
    messages = []
    for r in rows:
        m = dict(r)
        m["params"] = _json.loads(m.get("params", "{}"))
        messages.append(m)
    return ok({"messages": messages})

# ======================== 硅侣号查询 ========================

@app.post("/v1/smcp/lookup")
async def smcp_lookup(request: Request):
    """按硅侣号查找用户 — 添加好友时前端调用"""
    body = await request.json()
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    silicon_id = body.get("silicon_id", "").strip().upper()
    if not silicon_id:
        return err("PARAM", "missing silicon_id")
    with get_db() as conn:
        found = conn.execute("SELECT account_id, account_name, silicon_id FROM accounts WHERE silicon_id=?", (silicon_id,)).fetchone()
    if not found:
        return err("NOT_FOUND", f"硅侣号 {silicon_id} 不存在")
    return ok({"account_id": found["account_id"], "account_name": found["account_name"], "silicon_id": found["silicon_id"]})

# ======================== SMCP增强 ========================

@app.post("/v1/smcp/message/read")
async def smcp_message_read(request: Request):
    """标记消息已读"""
    body = await request.json()
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    msg_ids = body.get("msg_ids", [])
    if not msg_ids:
        return ok({"updated": 0})
    with _smcp_db() as conn:
        ph = ",".join("?" * len(msg_ids))
        cur = conn.execute(f"UPDATE smcp_messages SET delivered=1 WHERE msg_id IN ({ph}) AND to_user=?", msg_ids + [user_id])
    return ok({"updated": cur.rowcount})

@app.post("/v1/smcp/message/unread")
async def smcp_message_unread(request: Request):
    """未读消息计数"""
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    with _smcp_db() as conn:
        row = conn.execute("SELECT COUNT(*) as cnt FROM smcp_messages WHERE to_user=? AND delivered=0", (user_id,)).fetchone()
    return ok({"count": row["cnt"]})

@app.post("/v1/smcp/agent/online")
async def smcp_agent_online(request: Request):
    """查询好友在线状态"""
    user_id = _uid_from_req(request)
    if not user_id:
        return err("AUTH", "need auth", 401)
    friend_ids = (await request.json()).get("friend_ids", [])
    with _smcp_db() as conn:
        if friend_ids:
            ph = ",".join("?" * len(friend_ids))
            rows = conn.execute(f"SELECT user_id, status, last_heartbeat FROM smcp_agents WHERE user_id IN ({ph})", friend_ids).fetchall()
        else:
            # 返回所有好友的在线状态
            rows = conn.execute("SELECT DISTINCT a.user_id, a.status, a.last_heartbeat FROM smcp_agents a JOIN smcp_friends f ON a.user_id=f.friend_user_id WHERE f.user_id=? AND f.status='accepted'", (user_id,)).fetchall()
    agents = []
    for r in rows:
        agents.append({"user_id": r["user_id"], "status": r["status"], "last_heartbeat": r["last_heartbeat"]})
    return ok({"agents": agents})

# ===== SMCP 群聊 =====

@app.post("/v1/smcp/group/create")
async def smcp_group_create(request: Request):
    """创建群聊"""
    body = await request.json()
    account_id = request.headers.get("X-Account-Id", "")
    if not account_id:
        return {"ok": False, "error": "未认证"}
    
    name = body.get("name", "新群聊")
    member_ids = body.get("member_ids", [])  # list of user_ids
    
    group_id = f"G-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    now = datetime.utcnow().isoformat()
    
    # 创建者自动加入
    all_members = [account_id] + [m for m in member_ids if m != account_id]
    
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO smcp_groups (group_id, name, creator_id, created_at) VALUES (?,?,?,?)",
            (group_id, name, account_id, now)
        )
        for uid in all_members:
            role = "owner" if uid == account_id else "member"
            conn.execute(
                "INSERT OR IGNORE INTO smcp_group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)",
                (group_id, uid, role, now)
            )
        conn.commit()
        return {"ok": True, "data": {"group_id": group_id, "name": name, "members": all_members}}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


@app.post("/v1/smcp/group/list")
async def smcp_group_list(request: Request):
    """列出我加入的群"""
    account_id = request.headers.get("X-Account-Id", "")
    if not account_id:
        return {"ok": False, "error": "未认证"}
    
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT g.group_id, g.name, g.creator_id, g.created_at,
                      (SELECT COUNT(*) FROM smcp_group_members WHERE group_id=g.group_id) as member_count
               FROM smcp_groups g
               JOIN smcp_group_members m ON g.group_id = m.group_id
               WHERE m.user_id = ?""",
            (account_id,)
        ).fetchall()
        groups = []
        for r in rows:
            groups.append({
                "group_id": r[0], "name": r[1], "creator_id": r[2],
                "created_at": r[3], "member_count": r[4]
            })
        return {"ok": True, "data": {"groups": groups}}
    finally:
        conn.close()


@app.post("/v1/smcp/group/info")
async def smcp_group_info(request: Request):
    """获取群信息+成员列表"""
    body = await request.json()
    account_id = request.headers.get("X-Account-Id", "")
    group_id = body.get("group_id", "")
    
    conn = get_db()
    try:
        # 验证是否是群成员
        member = conn.execute(
            "SELECT 1 FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, account_id)
        ).fetchone()
        if not member:
            return {"ok": False, "error": "不是群成员"}
        
        group = conn.execute(
            "SELECT group_id, name, creator_id, created_at FROM smcp_groups WHERE group_id=?",
            (group_id,)
        ).fetchone()
        if not group:
            return {"ok": False, "error": "群不存在"}
        
        members = conn.execute(
            """SELECT m.user_id, m.role, m.joined_at, a.account_name, a.silicon_id
               FROM smcp_group_members m
               LEFT JOIN accounts a ON m.user_id = a.account_id
               WHERE m.group_id=?""",
            (group_id,)
        ).fetchall()
        
        return {"ok": True, "data": {
            "group_id": group[0], "name": group[1], "creator_id": group[2], "created_at": group[3],
            "members": [{"user_id": r[0], "role": r[1], "joined_at": r[2],
                         "account_name": r[3], "silicon_id": r[4]} for r in members]
        }}
    finally:
        conn.close()


@app.post("/v1/smcp/group/invite")
async def smcp_group_invite(request: Request):
    """邀请用户加入群（需是群成员）"""
    body = await request.json()
    account_id = request.headers.get("X-Account-Id", "")
    group_id = body.get("group_id", "")
    invite_user_id = body.get("user_id", "")
    
    if not invite_user_id:
        return {"ok": False, "error": "缺少user_id"}
    
    conn = get_db()
    try:
        # 验证邀请人是群成员
        inviter = conn.execute(
            "SELECT role FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, account_id)
        ).fetchone()
        if not inviter:
            return {"ok": False, "error": "你不是群成员"}
        
        # 直接加入（简化版，后续可加邀请确认）
        now = datetime.utcnow().isoformat()
        conn.execute(
            "INSERT OR IGNORE INTO smcp_group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)",
            (group_id, invite_user_id, "member", now)
        )
        # 更新群名下member_count由查询时计算
        conn.commit()
        return {"ok": True, "data": {"group_id": group_id, "user_id": invite_user_id, "role": "member"}}
    finally:
        conn.close()


@app.post("/v1/smcp/group/leave")
async def smcp_group_leave(request: Request):
    """退出群"""
    body = await request.json()
    account_id = request.headers.get("X-Account-Id", "")
    group_id = body.get("group_id", "")
    
    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, account_id)
        )
        # 如果群主退出，群解散（或转让，简化版先解散）
        group = conn.execute(
            "SELECT creator_id FROM smcp_groups WHERE group_id=?", (group_id,)
        ).fetchone()
        if group and group[0] == account_id:
            conn.execute("DELETE FROM smcp_group_members WHERE group_id=?", (group_id,))
            conn.execute("DELETE FROM smcp_groups WHERE group_id=?", (group_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.post("/v1/smcp/group/message/send")
async def smcp_group_message_send(request: Request):
    """向群发送消息"""
    body = await request.json()
    account_id = request.headers.get("X-Account-Id", "")
    from_agent = body.get("from_agent", "")
    group_id = body.get("group_id", "")
    msg_type = body.get("type", "notify")
    method = body.get("method", "im.send")
    params = body.get("params", {})
    
    if not group_id:
        return {"ok": False, "error": "缺少group_id"}
    
    conn = get_db()
    try:
        # 验证是群成员
        member = conn.execute(
            "SELECT 1 FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, account_id)
        ).fetchone()
        if not member:
            return {"ok": False, "error": "不是群成员"}
        
        # 获取所有群成员
        members = conn.execute(
            "SELECT user_id FROM smcp_group_members WHERE group_id=?", (group_id,)
        ).fetchall()
        
        msg_id = f"M-{int(time.time())}-{uuid.uuid4().hex[:8]}"
        now_ts = time.time()
        now_str = datetime.utcnow().isoformat()
        
        # 给每个非自己的群成员投递消息
        for (uid,) in members:
            if uid == account_id:
                continue
            # 找到该用户的agent
            agents = conn.execute(
                "SELECT agent_id FROM smcp_agents WHERE user_id=? AND status='online'",
                (uid,)
            ).fetchall()
            target_agent = agents[0][0] if agents else f"A-{uid[:8]}-siliconm"
            
            conn.execute(
                "INSERT INTO smcp_messages (msg_id, from_agent, to_agent, to_user, msg_type, method, params, timestamp, hmac, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (msg_id + f"-{uid[:4]}", from_agent, target_agent, uid, msg_type, method,
                 json.dumps({**params, "group_id": group_id}), now_ts, "", now_str)
            )
        
        conn.commit()
        return {"ok": True, "data": {"msg_id": msg_id, "delivered_to": len(members) - 1}}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


@app.post("/v1/smcp/group/kick")
async def smcp_group_kick(request: Request):
    """踢出群成员（仅群主/管理员可操作）"""
    body = await request.json()
    account_id = request.headers.get("X-Account-Id", "")
    group_id = body.get("group_id", "")
    kick_user_id = body.get("user_id", "")
    
    if not kick_user_id:
        return {"ok": False, "error": "缺少user_id"}
    
    conn = get_db()
    try:
        operator = conn.execute(
            "SELECT role FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, account_id)
        ).fetchone()
        if not operator:
            return {"ok": False, "error": "你不是群成员"}
        
        if operator[0] not in ("owner", "admin"):
            return {"ok": False, "error": "权限不足，仅群主和管理员可踢人"}
        
        target = conn.execute(
            "SELECT role FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, kick_user_id)
        ).fetchone()
        if not target:
            return {"ok": False, "error": "目标用户不在群中"}
        
        if target[0] == "owner":
            return {"ok": False, "error": "不能踢出群主"}
        
        if operator[0] == "admin" and target[0] == "admin":
            return {"ok": False, "error": "管理员不能踢管理员，仅群主可以"}
        
        conn.execute(
            "DELETE FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, kick_user_id)
        )
        conn.commit()
        return {"ok": True, "data": {"group_id": group_id, "kicked_user": kick_user_id}}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


@app.post("/v1/smcp/group/transfer")
async def smcp_group_transfer(request: Request):
    """转让群主（仅群主可操作）"""
    body = await request.json()
    account_id = request.headers.get("X-Account-Id", "")
    group_id = body.get("group_id", "")
    new_owner_id = body.get("user_id", "")
    
    if not new_owner_id:
        return {"ok": False, "error": "缺少user_id"}
    
    conn = get_db()
    try:
        operator = conn.execute(
            "SELECT role FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, account_id)
        ).fetchone()
        if not operator or operator[0] != "owner":
            return {"ok": False, "error": "仅群主可转让"}
        
        target = conn.execute(
            "SELECT role FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, new_owner_id)
        ).fetchone()
        if not target:
            return {"ok": False, "error": "目标用户不在群中"}
        
        conn.execute(
            "UPDATE smcp_group_members SET role='admin' WHERE group_id=? AND user_id=?",
            (group_id, account_id)
        )
        conn.execute(
            "UPDATE smcp_group_members SET role='owner' WHERE group_id=? AND user_id=?",
            (group_id, new_owner_id)
        )
        conn.execute(
            "UPDATE smcp_groups SET creator_id=? WHERE group_id=?",
            (new_owner_id, group_id)
        )
        conn.commit()
        return {"ok": True, "data": {"group_id": group_id, "new_owner": new_owner_id}}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


@app.post("/v1/smcp/group/setRole")
async def smcp_group_set_role(request: Request):
    """设置成员角色：群主可设admin/member"""
    body = await request.json()
    account_id = request.headers.get("X-Account-Id", "")
    group_id = body.get("group_id", "")
    target_user_id = body.get("user_id", "")
    role = body.get("role", "member")
    
    if not target_user_id:
        return {"ok": False, "error": "缺少user_id"}
    
    if role not in ("admin", "member"):
        return {"ok": False, "error": "role只能是admin或member"}
    
    conn = get_db()
    try:
        operator = conn.execute(
            "SELECT role FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, account_id)
        ).fetchone()
        if not operator or operator[0] != "owner":
            return {"ok": False, "error": "仅群主可设置管理员"}
        
        if target_user_id == account_id:
            return {"ok": False, "error": "不能修改自己的角色，请使用转让功能"}
        
        target = conn.execute(
            "SELECT role FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, target_user_id)
        ).fetchone()
        if not target:
            return {"ok": False, "error": "目标用户不在群中"}
        
        conn.execute(
            "UPDATE smcp_group_members SET role=? WHERE group_id=? AND user_id=?",
            (role, group_id, target_user_id)
        )
        conn.commit()
        return {"ok": True, "data": {"group_id": group_id, "user_id": target_user_id, "role": role}}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


@app.post("/v1/smcp/group/update")
async def smcp_group_update(request: Request):
    """修改群信息（群主/管理员可操作）"""
    body = await request.json()
    account_id = request.headers.get("X-Account-Id", "")
    group_id = body.get("group_id", "")
    new_name = body.get("name", "")
    
    conn = get_db()
    try:
        operator = conn.execute(
            "SELECT role FROM smcp_group_members WHERE group_id=? AND user_id=?",
            (group_id, account_id)
        ).fetchone()
        if not operator:
            return {"ok": False, "error": "你不是群成员"}
        
        if operator[0] not in ("owner", "admin"):
            return {"ok": False, "error": "权限不足，仅群主和管理员可修改群信息"}
        
        if new_name:
            conn.execute(
                "UPDATE smcp_groups SET name=? WHERE group_id=?",
                (new_name, group_id)
            )
        else:
            return {"ok": False, "error": "没有需要更新的字段"}
        
        conn.commit()
        return {"ok": True, "data": {"group_id": group_id}}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


# ===== SMCP 文件传输 =====

@app.post("/v1/smcp/file/upload")
async def smcp_file_upload(request: Request):
    """上传文件，返回file_id和下载URL"""
    account_id = request.headers.get("X-Account-Id", "")
    if not account_id:
        return {"ok": False, "error": "未认证"}
    
    body = await request.json()
    filename = body.get("filename", "unknown")
    file_data = body.get("data", "")  # base64 encoded
    content_type = body.get("content_type", "application/octet-stream")
    
    if not file_data:
        return {"ok": False, "error": "缺少文件数据"}
    
    import base64
    try:
        raw_data = base64.b64decode(file_data)
    except Exception:
        return {"ok": False, "error": "base64解码失败"}
    
    # 限制10MB
    if len(raw_data) > 10 * 1024 * 1024:
        return {"ok": False, "error": "文件超过10MB限制"}
    
    file_id = f"F-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    file_path = os.path.join(os.path.dirname(__file__), "uploads", file_id)
    
    # 保存元数据
    meta = {
        "file_id": file_id,
        "filename": filename,
        "content_type": content_type,
        "size": len(raw_data),
        "uploader": account_id,
        "created_at": datetime.utcnow().isoformat(),
    }
    
    try:
        with open(file_path, "wb") as f:
            f.write(raw_data)
        with open(file_path + ".meta", "w") as f:
            json.dump(meta, f)
        return {
            "ok": True,
            "data": {
                "file_id": file_id,
                "filename": filename,
                "size": len(raw_data),
                "url": f"/v1/smcp/file/download/{file_id}",
            }
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/v1/smcp/file/download/{file_id}")
async def smcp_file_download(file_id: str):
    """下载文件"""
    file_path = os.path.join(os.path.dirname(__file__), "uploads", file_id)
    meta_path = file_path + ".meta"
    
    if not os.path.exists(file_path) or not os.path.exists(meta_path):
        return {"ok": False, "error": "文件不存在"}
    
    with open(meta_path, "r") as f:
        meta = json.load(f)
    
    from fastapi.responses import FileResponse
    return FileResponse(
        file_path,
        media_type=meta.get("content_type", "application/octet-stream"),
        filename=meta.get("filename", file_id),
    )

# ===== 文件过期清理 =====

@app.post("/v1/smcp/file/cleanup")
async def smcp_file_cleanup(request: Request):
    """清理7天前的文件"""
    account_id = request.headers.get("X-Account-Id", "")
    if not account_id:
        return {"ok": False, "error": "未认证"}
    
    import time
    uploads_dir = os.path.join(os.path.dirname(__file__), "uploads")
    if not os.path.exists(uploads_dir):
        return {"ok": True, "deleted": 0}
    
    now = time.time()
    cutoff = now - 7 * 24 * 3600  # 7天前
    deleted = 0
    
    for fname in os.listdir(uploads_dir):
        fpath = os.path.join(uploads_dir, fname)
        if os.path.isfile(fpath) and os.path.getmtime(fpath) < cutoff:
            os.remove(fpath)
            deleted += 1
    
    return {"ok": True, "deleted": deleted}


# ======================================================================
# v4.1 云端聊天 (opencode 免费模型转发) + 账号激活绑定
# ======================================================================

import httpx

OPENCODE_BASE = os.environ.get("OPENCODE_BASE", "http://127.0.0.1:4103")
OPENCODE_SESSION_TIMEOUT = 15          # 建会话超时(秒)
OPENCODE_MSG_TIMEOUT = 90              # 转发消息阻塞超时(秒)
CHAT_MODEL_PROVIDER = "opencode"
# T030 校准(2026-09-14 实测): nemotron-3-ultra-free 该模型免费池已耗尽(机器级限流
# Rate limit exceeded, 持续>3h); machine-id 重置后 ling/mimo/muse 恢复出字。
# ling-3.0-flash-fin-free 实测 2-5s 出字, 质量达标 → 切换为默认。
# 备选: mimo-v2.5-free(27s) / muse-spark-1.2-contributor-free(2s)
CHAT_MODEL_ID = "ling-3.0-flash-fin-free"
CHAT_AGENT = "build"
CHAT_RATE_LIMIT = 20                   # 条/分钟/账号
CHAT_MSG_MAX_LEN = 8000
CHAT_HISTORY_LIMIT = 200

CHAT_SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_sessions (
    account_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_active REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_rate_limit (
    account_id TEXT PRIMARY KEY,
    window_start REAL NOT NULL,
    count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_acc ON chat_messages(account_id, ts);
"""

def _chat_db():
    conn = get_db()
    conn.executescript(CHAT_SCHEMA)
    return conn


def _is_activated(conn, account_id: str) -> bool:
    """激活态判定: 存在 bound_account=本账号 且 status='used' 的激活码。"""
    if not account_id:
        return False
    row = conn.execute(
        "SELECT 1 FROM activation_codes WHERE bound_account=? AND status='used' LIMIT 1",
        (account_id,)).fetchone()
    return bool(row)


# ---------- opencode 会话管理 (T004) ----------

async def _oc_create_session() -> str:
    """在 opencode 实例上创建新会话, 返回 session_id。"""
    async with httpx.AsyncClient(timeout=OPENCODE_SESSION_TIMEOUT) as cli:
        r = await cli.post(OPENCODE_BASE + "/session", json={})
        r.raise_for_status()
        data = r.json()
    sid = data.get("id") or data.get("sessionID") or ""
    if not sid:
        raise RuntimeError("opencode /session 未返回 id")
    return sid


async def _oc_send_message(session_id: str, text: str) -> str:
    """转发用户消息到 opencode, 阻塞等待完成, 提取 text parts 拼接回复。"""
    payload = {
        "model": {"providerID": CHAT_MODEL_PROVIDER, "modelID": CHAT_MODEL_ID},
        "agent": CHAT_AGENT,
        "parts": [{"type": "text", "text": text}],
    }
    async with httpx.AsyncClient(timeout=OPENCODE_MSG_TIMEOUT) as cli:
        r = await cli.post(f"{OPENCODE_BASE}/session/{session_id}/message", json=payload)
        r.raise_for_status()
        data = r.json()
    parts = data.get("parts", [])
    reply = "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()
    return reply


async def _oc_get_or_create_session(account_id: str) -> str:
    """查 chat_sessions 映射 → 命中复用; 未命中/失效则新建并落库。"""
    with _chat_db() as conn:
        row = conn.execute("SELECT session_id FROM chat_sessions WHERE account_id=?",
                           (account_id,)).fetchone()
    if row:
        return row["session_id"]
    sid = await _oc_create_session()
    now = time.time()
    with _chat_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO chat_sessions (account_id, session_id, created_at, last_active)"
            " VALUES (?,?,?,?)", (account_id, sid, now, now))
    return sid


def _chat_reset_session(account_id: str):
    """opencode 会话失效时清除映射, 下次请求自动重建。"""
    with _chat_db() as conn:
        conn.execute("DELETE FROM chat_sessions WHERE account_id=?", (account_id,))


# ---------- POST /v1/chat (T005) ----------

@app.post("/v1/chat")
async def chat_send(request: Request):
    body = await request.json()
    account_id = _uid_from_req(request)
    if not account_id:
        return err("auth_failed", "缺少账号身份(X-Account-Id)", 401)
    message = (body.get("message") or "").strip()
    if not message:
        return err("bad_request", "message必填")
    if len(message) > CHAT_MSG_MAX_LEN:
        return err("bad_request", f"消息过长(>{CHAT_MSG_MAX_LEN}字符)")

    with _chat_db() as conn:
        if not _is_activated(conn, account_id):
            return err("not_activated", "账号未激活, 请先激活", 403)
        # 频控: 20 条/分钟/账号
        now = time.time()
        rl = conn.execute("SELECT window_start, count FROM chat_rate_limit WHERE account_id=?",
                          (account_id,)).fetchone()
        if rl and now - rl["window_start"] < 60:
            if rl["count"] >= CHAT_RATE_LIMIT:
                return err("rate_limited", f"请求过于频繁, 每分钟最多{CHAT_RATE_LIMIT}条", 429)
            conn.execute("UPDATE chat_rate_limit SET count=count+1 WHERE account_id=?",
                         (account_id,))
        elif rl:
            conn.execute("UPDATE chat_rate_limit SET window_start=?, count=1 WHERE account_id=?",
                         (now, account_id))
        else:
            conn.execute("INSERT INTO chat_rate_limit (account_id, window_start, count)"
                         " VALUES (?,?,1)", (account_id, now))
        # 用户消息先落档(即使 AI 超时, 历史仍可见)
        conn.execute("INSERT INTO chat_messages (account_id, role, text, ts) VALUES (?,?,?,?)",
                     (account_id, "user", message, now))

    # 查/建 opencode 会话并转发
    try:
        session_id = await _oc_get_or_create_session(account_id)
    except httpx.TimeoutException:
        return err("ai_timeout", "AI会话创建超时, 请稍后重试", 504)
    except Exception as e:
        return err("ai_error", f"AI服务不可用: {e}", 502)

    try:
        reply = await _oc_send_message(session_id, message)
    except httpx.TimeoutException:
        return err("ai_timeout", "AI响应超时, 请稍后重试", 504)
    except Exception:
        # 会话可能失效 → 清映射, 客户端可重试自动重建
        _chat_reset_session(account_id)
        return err("ai_error", "AI服务异常, 请重试", 502)

    if not reply:
        _chat_reset_session(account_id)
        return err("ai_error", "AI返回空回复, 请重试", 502)

    now = time.time()
    with _chat_db() as conn:
        conn.execute("INSERT INTO chat_messages (account_id, role, text, ts) VALUES (?,?,?,?)",
                     (account_id, "assistant", reply, now))
        conn.execute("UPDATE chat_sessions SET last_active=? WHERE account_id=?",
                     (now, account_id))
    return ok({"reply": reply, "session_id": session_id})


# ---------- GET /v1/chat/history (T006) ----------

@app.get("/v1/chat/history")
async def chat_history(request: Request):
    account_id = _uid_from_req(request)
    if not account_id:
        return err("auth_failed", "缺少账号身份(X-Account-Id)", 401)
    with _chat_db() as conn:
        if not _is_activated(conn, account_id):
            return err("not_activated", "账号未激活, 请先激活", 403)
        rows = conn.execute(
            "SELECT role, text, ts FROM chat_messages WHERE account_id=?"
            " ORDER BY ts ASC, id ASC LIMIT ?",
            (account_id, CHAT_HISTORY_LIMIT)).fetchall()
        sess = conn.execute("SELECT session_id FROM chat_sessions WHERE account_id=?",
                            (account_id,)).fetchone()
    messages = [{"role": r["role"], "text": r["text"], "time": r["ts"]} for r in rows]
    return ok({"messages": messages, "count": len(messages),
               "session_id": sess["session_id"] if sess else None})


# ---------- POST /v1/activate/bind ----------
# 安卓轻量激活绑定: 对齐 /v1/code/validate 的简单调用形态 +
# /v1/account/activate 的账号绑定语义(X-Account-Id 头认证, 免 HMAC)。

@app.post("/v1/activate/bind")
async def activate_bind(request: Request):
    body = await request.json()
    account_id = _uid_from_req(request)
    if not account_id:
        return err("auth_failed", "缺少账号身份(X-Account-Id)", 401)
    code = (body.get("code") or "").strip().upper()
    product = body.get("product", "siliconmate")
    if not code:
        return err("ERR_FORMAT", "激活码必填")
    code_hash = sha256_hex(code)
    with get_db() as conn:
        row = conn.execute(
            "SELECT code_id,plan,product,status,expires_at,bound_account FROM activation_codes"
            " WHERE code_hash=?", (code_hash,)).fetchone()
        if not row:
            return err("ERR_INVALID", "激活码无效", 401)
        if row["product"] != product:
            return err("ERR_WRONG_PRODUCT", "此激活码不适用于当前产品", 401)
        # 幂等: 本账号已用此码激活 → 直接成功返回
        if row["status"] == "used" and row["bound_account"] == account_id:
            plan = row["plan"]
            tunnel = _tunnel_for_plan(conn, plan)
            return ok({"plan": plan, "code_id": row["code_id"], "tunnel": tunnel,
                       "activated": True, "already": True})
        if row["status"] != "active":
            return err("ERR_INVALID", "激活码已" + row["status"], 401)
        if row["expires_at"]:
            from datetime import datetime as _dt, timezone as _tz
            try:
                exp = _dt.fromisoformat(row["expires_at"]).astimezone(_tz.utc)
                if _dt.now(_tz.utc) > exp:
                    return err("ERR_EXPIRED", "激活码已过期", 401)
            except Exception:
                pass
        existing = conn.execute(
            "SELECT code_id FROM activation_codes WHERE bound_account=? AND status='used' LIMIT 1",
            (account_id,)).fetchone()
        if existing:
            return err("ERR_ALREADY_ACTIVATED", "账号已激活", 409)
        plan = row["plan"]
        conn.execute(
            "UPDATE activation_codes SET status='used',bound_account=?,used_at=? WHERE code_id=?",
            (account_id, now_iso(), row["code_id"]))
        tunnel = _tunnel_for_plan(conn, plan)
    return ok({"plan": plan, "code_id": row["code_id"], "tunnel": tunnel, "activated": True})


def _tunnel_for_plan(conn, plan: str):
    tc = conn.execute(
        "SELECT server,server_port,uuid,flow,server_name,public_key,short_id,route_domains"
        " FROM tunnel_configs WHERE plan=?", (plan,)).fetchone()
    if not tc:
        return None
    return {
        "server": tc["server"], "server_port": tc["server_port"],
        "uuid": tc["uuid"], "flow": tc["flow"],
        "server_name": tc["server_name"], "public_key": tc["public_key"],
        "short_id": tc["short_id"],
        "route_domains": json.loads(tc["route_domains"]),
    }
