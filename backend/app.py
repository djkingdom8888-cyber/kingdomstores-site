import json
import os
import shutil
import sqlite3
import subprocess
import time
import secrets
from pathlib import Path

import stripe
from dotenv import load_dotenv
from flask import Flask, jsonify, request, session, send_from_directory, render_template, abort
from flask_socketio import SocketIO, join_room, emit
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

import shipping

BASE_DIR = Path(__file__).resolve().parent
SITE_DIR = BASE_DIR.parent
# In production this points at a mounted persistent disk (e.g. /data on Render), so the
# database and uploaded files survive redeploys — code gets replaced by git, DATA_DIR doesn't.
# Defaults to the repo itself for local dev, matching prior behavior.
DATA_DIR = Path(os.environ.get("DATA_DIR", str(SITE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "kingdomstores.db"

load_dotenv(BASE_DIR / ".env")

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "").strip()
STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY", "").strip()
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
stripe.api_key = STRIPE_SECRET_KEY  # blank until configured — calls fail loudly, not silently

IS_PRODUCTION = os.environ.get("FLASK_ENV", "development").strip().lower() == "production"

app = Flask(__name__, static_folder=str(SITE_DIR), static_url_path="")
app.secret_key = os.environ.get("KS_SECRET_KEY") or secrets.token_hex(32)
if IS_PRODUCTION and not os.environ.get("KS_SECRET_KEY"):
    raise RuntimeError(
        "Set KS_SECRET_KEY in backend/.env before running with FLASK_ENV=production — "
        "an auto-generated key would log every admin out on each restart/deploy."
    )
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Real HTTPS in production; local dev over plain http still needs this off.
    SESSION_COOKIE_SECURE=IS_PRODUCTION,
    MAX_CONTENT_LENGTH=300 * 1024 * 1024,  # 300MB — generous for phone-exported video clips
)

VIDEOS_DIR = DATA_DIR / "videos"
VIDEOS_DIR.mkdir(exist_ok=True)
ALLOWED_VIDEO_EXTENSIONS = {"mp4", "mov", "m4v", "webm"}

# Live streaming: pure signaling relay over Socket.IO (chat + WebRTC SDP/ICE).
# async_mode="gevent" is required to run correctly under gunicorn with a
# GeventWebSocketWorker: leaving this as "threading" while running gunicorn
# with a gevent-based worker class causes a websocket handshake failure
# under real gunicorn ("rsv is not implemented, yet"), so both the worker
# class (set on the deploy, not here) and this async_mode must be changed
# together. Note this alone does not make room state shared across multiple
# gunicorn *worker processes* (e.g. `--workers 2`) — Flask-SocketIO needs an
# explicit message_queue (e.g. Redis) for that; without it, only clients
# landing on the same worker process will see each other's messages.
socketio = SocketIO(app, async_mode="gevent", cors_allowed_origins="*", max_http_buffer_size=300 * 1024 * 1024)

# ---- very small brute-force guard on /api/login -------------------------
_login_attempts = {}  # ip -> (count, first_attempt_ts)
MAX_ATTEMPTS = 5
WINDOW_SECONDS = 60


def _rate_limited(ip):
    count, first = _login_attempts.get(ip, (0, time.time()))
    if time.time() - first > WINDOW_SECONDS:
        _login_attempts[ip] = (0, time.time())
        return False
    return count >= MAX_ATTEMPTS


def _register_failure(ip):
    count, first = _login_attempts.get(ip, (0, time.time()))
    if time.time() - first > WINDOW_SECONDS:
        _login_attempts[ip] = (1, time.time())
    else:
        _login_attempts[ip] = (count + 1, first)


def _register_success(ip):
    _login_attempts.pop(ip, None)


def parse_price_to_cents(value):
    """Accepts "$26.00", "26", or 26.0 and returns integer cents, or None if invalid."""
    try:
        if isinstance(value, (int, float)):
            dollars = float(value)
        else:
            dollars = float(str(value).replace("$", "").replace(",", "").strip())
        if dollars < 0:
            return None
        return int(round(dollars * 100))
    except (ValueError, TypeError):
        return None


# ---- database -------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ---- live sessions: data access helpers (mirrors the tracks/products pattern above) --
def create_live_session(title, host_name):
    room_code = secrets.token_urlsafe(6).replace("_", "").replace("-", "")[:8]
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO live_sessions (title, host_name, room_code) VALUES (?,?,?)",
        (title, host_name, room_code),
    )
    conn.commit()
    session_id = cur.lastrowid
    conn.close()
    return session_id, room_code


def get_live_session_by_room(room_code):
    conn = get_db()
    row = conn.execute("SELECT * FROM live_sessions WHERE room_code = ?", (room_code,)).fetchone()
    conn.close()
    return row


def list_live_sessions(status=None):
    conn = get_db()
    if status:
        rows = conn.execute(
            "SELECT * FROM live_sessions WHERE status = ? ORDER BY created_at DESC", (status,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM live_sessions ORDER BY created_at DESC").fetchall()
    conn.close()
    return rows


def set_live_status(session_id, status):
    conn = get_db()
    if status == "live":
        conn.execute(
            "UPDATE live_sessions SET status = ?, started_at = datetime('now') WHERE id = ?",
            (status, session_id),
        )
    elif status == "ended":
        conn.execute(
            "UPDATE live_sessions SET status = ?, ended_at = datetime('now') WHERE id = ?",
            (status, session_id),
        )
    else:
        conn.execute("UPDATE live_sessions SET status = ? WHERE id = ?", (status, session_id))
    conn.commit()
    conn.close()


def set_live_recording(session_id, recording_path):
    conn = get_db()
    conn.execute("UPDATE live_sessions SET recording_path = ? WHERE id = ?", (recording_path, session_id))
    conn.commit()
    conn.close()


def add_chat_message(session_id, sender_name, message):
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO chat_messages (live_session_id, sender_name, message) VALUES (?,?,?)",
        (session_id, sender_name, message),
    )
    conn.commit()
    conn.close()
    return cur.lastrowid


def list_chat_messages(session_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM chat_messages WHERE live_session_id = ? ORDER BY id ASC", (session_id,)
    ).fetchall()
    conn.close()
    return rows


def create_camera_request(session_id, viewer_name, socket_id):
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO camera_requests (live_session_id, viewer_name, socket_id) VALUES (?,?,?)",
        (session_id, viewer_name, socket_id),
    )
    conn.commit()
    conn.close()
    return cur.lastrowid


def get_camera_request(request_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM camera_requests WHERE id = ?", (request_id,)).fetchone()
    conn.close()
    return row


def set_camera_request_status(request_id, status):
    conn = get_db()
    conn.execute("UPDATE camera_requests SET status = ? WHERE id = ?", (status, request_id))
    conn.commit()
    conn.close()


def _migrate_products_price_cents(conn):
    """Backfills price_cents/is_physical for databases created before those columns existed."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(products)").fetchall()]
    if "price_cents" not in cols:
        conn.execute("ALTER TABLE products ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0")
    if "is_physical" not in cols:
        conn.execute("ALTER TABLE products ADD COLUMN is_physical INTEGER NOT NULL DEFAULT 0")
    conn.commit()

    for row in conn.execute("SELECT id, price, price_cents FROM products").fetchall():
        if row["price_cents"]:
            continue
        try:
            cents = int(round(float(row["price"].replace("$", "").replace(",", "")) * 100))
        except (ValueError, AttributeError):
            cents = 0
        conn.execute("UPDATE products SET price_cents = ? WHERE id = ?", (cents, row["id"]))
    conn.commit()


def init_db():
    fresh = not DB_PATH.exists()
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            artist TEXT NOT NULL,
            len TEXT NOT NULL,
            seconds INTEGER NOT NULL,
            src TEXT,
            type TEXT,
            embed_id TEXT,
            embed_url TEXT,
            sort_order INTEGER NOT NULL,
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS subscribers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            source TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type_label TEXT NOT NULL,
            price TEXT NOT NULL,
            price_cents INTEGER NOT NULL DEFAULT 0,
            is_physical INTEGER NOT NULL DEFAULT 0,
            preview_track_id TEXT,
            sort_order INTEGER NOT NULL,
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS apparel (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            price TEXT NOT NULL,
            price_cents INTEGER NOT NULL DEFAULT 0,
            image_path TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            stripe_session_id TEXT UNIQUE,
            customer_email TEXT,
            items TEXT NOT NULL,
            amount_total INTEGER NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'usd',
            status TEXT NOT NULL DEFAULT 'pending',
            shipping_name TEXT,
            shipping_address TEXT,
            carrier TEXT,
            tracking_number TEXT,
            shipping_label_url TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS live_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            host_name TEXT NOT NULL DEFAULT '',
            room_code TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled, live, ended
            recording_path TEXT NOT NULL DEFAULT '',
            started_at TEXT,
            ended_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            live_session_id INTEGER NOT NULL REFERENCES live_sessions(id),
            sender_name TEXT NOT NULL,
            message TEXT NOT NULL,
            sent_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS camera_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            live_session_id INTEGER NOT NULL REFERENCES live_sessions(id),
            viewer_name TEXT NOT NULL,
            socket_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, denied, ended
            requested_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        """
    )
    conn.commit()
    _migrate_products_price_cents(conn)

    if fresh:
        conn.executemany(
            "INSERT INTO tracks (id, title, artist, len, seconds, src, sort_order) VALUES (?,?,?,?,?,?,?)",
            [
                ("drums-of-the-desert", "Drums Of The Desert", "KINGDOM STORES", "4:48", 289, "audio/drums-of-the-desert.mp3", 1),
                ("dawn-of-mercy", "Dawn Of Mercy", "KINGDOM STORES", "2:50", 170, "audio/dawn-of-mercy.mp3", 2),
                ("wakati-wangu", "Wakati Wangu", "KINGDOM STORES", "4:27", 267, "audio/wakati-wangu.wav", 3),
            ],
        )
        conn.executemany(
            "INSERT INTO products (id, name, type_label, price, price_cents, is_physical, preview_track_id, sort_order) VALUES (?,?,?,?,?,?,?,?)",
            [
                ("drums-of-the-desert", '"Drums Of The Desert"', "Full Track — MP3 Download", "$1.99", 199, 0, "drums-of-the-desert", 1),
                ("dawn-of-mercy", '"Dawn Of Mercy"', "Full Track — MP3 Download", "$4.99", 499, 0, "dawn-of-mercy", 2),
                ("wakati-wangu", '"Wakati Wangu"', "Full Track — WAV Download", "$6.99", 699, 0, "wakati-wangu", 3),
                ("discography-bundle", "Full Discography Bundle", "All Songs + Videos — Digital Bundle", "$19.99", 1999, 0, "drums-of-the-desert", 4),
            ],
        )
        conn.commit()

    # Apparel table is newer than `fresh` DBs already in the wild, so seed it
    # independently the first time it's empty rather than gating on `fresh`.
    if conn.execute("SELECT COUNT(*) FROM apparel").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO apparel (id, name, category, price, price_cents, image_path, sort_order) VALUES (?,?,?,?,?,?,?)",
            [
                ("jehovah-tsidkenu-hoodie", '"Jehovah Tsidkenu" Hoodie', "hoodie", "$52.00", 5200, "images/apparel/jehovah-tsidkenu-hoodie-1.png", 1),
                ("appointed-time-hoodie", '"Appointed Time" Hoodie', "hoodie", "$52.00", 5200, "images/apparel/appointed-time-hoodie.png", 2),
                ("spiritual-charge-hoodie", '"Spiritual Charge" Hoodie', "hoodie", "$52.00", 5200, "images/apparel/spiritual-charge-hoodie.png", 3),
                ("on-time-god-hoodie", '"On Time GOD" Hoodie', "hoodie", "$52.00", 5200, "images/apparel/on-time-god-hoodie.png", 4),
                ("careece-topher-hoodie", '"The Worshipper" Crewneck', "hoodie", "$48.00", 4800, "images/apparel/careece-topher-worshipper-hoodie.png", 5),
                ("holy-spirit-vibes-tee", '"Holy Spirit Vibes" Tee', "tshirt", "$28.00", 2800, "images/apparel/holy-spirit-vibes-tee.png", 6),
                ("holy-spirit-overflow-tee", '"I Need Overflow" Tee', "tshirt", "$26.00", 2600, "images/apparel/holy-spirit-overflow-tee.png", 7),
                ("emunah-bucket-hat", '"Emunah" Bucket Hat', "hat", "$32.00", 3200, "images/apparel/emunah-bucket-hat.png", 8),
            ],
        )
        conn.commit()

    # Seed a default admin only if none exists yet.
    if conn.execute("SELECT COUNT(*) FROM admins").fetchone()[0] == 0:
        default_user = os.environ.get("KS_ADMIN_USER", "admin")
        default_pass = os.environ.get("KS_ADMIN_PASS") or secrets.token_urlsafe(9)
        conn.execute(
            "INSERT INTO admins (username, password_hash) VALUES (?, ?)",
            (default_user, generate_password_hash(default_pass, method="pbkdf2:sha256")),
        )
        conn.commit()
        (BASE_DIR / "INITIAL_ADMIN_CREDENTIALS.txt").write_text(
            f"username: {default_user}\npassword: {default_pass}\n"
            "Delete this file after you've noted the password (or change it — see README).\n"
        )

    # Opt-in recovery/change path: if KS_ADMIN_RESET_PASSWORD is set, upsert that
    # password for the admin user on startup. The auto-generated password from first
    # boot only lives on the app container's ephemeral filesystem, not the persistent
    # disk, so this is how access gets restored (or the password changed) in production.
    reset_pass = os.environ.get("KS_ADMIN_RESET_PASSWORD")
    if reset_pass:
        reset_user = os.environ.get("KS_ADMIN_USER", "admin")
        conn.execute(
            "UPDATE admins SET password_hash = ? WHERE username = ?",
            (generate_password_hash(reset_pass, method="pbkdf2:sha256"), reset_user),
        )
        conn.commit()

    conn.close()


# ---- auth helpers -----------------------------------------------------------
def login_required(fn):
    from functools import wraps

    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("admin_id"):
            return jsonify({"error": "unauthorized"}), 401
        return fn(*args, **kwargs)

    return wrapper


# ---- static site -------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# Videos live on the persistent disk (DATA_DIR), which sits outside static_folder
# (the git checkout) in production — Flask's built-in static handler can't see it,
# so uploaded videos need this explicit route to actually be servable.
@app.route("/videos/<path:filename>")
def serve_video(filename):
    return send_from_directory(VIDEOS_DIR, filename)


# ---- live streaming: public pages (sibling of the tracks/video listing above) ---------
@app.get("/live")
def live_list_page():
    live_now = list_live_sessions(status="live")
    scheduled = list_live_sessions(status="scheduled")
    ended = [s for s in list_live_sessions(status="ended") if s["recording_path"]]
    return render_template("live_list.html", live_now=live_now, scheduled=scheduled, ended=ended)


@app.get("/live/<room_code>/replay")
def live_replay_page(room_code):
    live_session = get_live_session_by_room(room_code)
    if not live_session or not live_session["recording_path"]:
        abort(404)
    return render_template("live_replay.html", live_session=live_session)


@app.get("/live/<room_code>/host")
def live_host_page(room_code):
    live_session = get_live_session_by_room(room_code)
    if not live_session:
        abort(404)
    return render_template("live_host.html", live_session=live_session)


@app.get("/live/<room_code>")
def live_room_page(room_code):
    live_session = get_live_session_by_room(room_code)
    if not live_session:
        abort(404)
    return render_template("live_room.html", live_session=live_session)


@app.post("/live/<room_code>/upload-recording")
def upload_live_recording(room_code):
    live_session = get_live_session_by_room(room_code)
    if not live_session:
        abort(404)
    file = request.files.get("recording")
    if not file:
        return jsonify({"ok": False, "error": "no file"}), 400
    filename = f"live-{room_code}-{secrets.token_hex(4)}.webm"
    file.save(VIDEOS_DIR / filename)
    rel_path = f"videos/{filename}"
    set_live_recording(live_session["id"], rel_path)
    return jsonify({"ok": True, "path": rel_path})


# ---- auth API -----------------------------------------------------------------
@app.post("/api/login")
def login():
    ip = request.remote_addr or "unknown"
    if _rate_limited(ip):
        return jsonify({"error": "Too many attempts. Try again in a minute."}), 429

    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    conn = get_db()
    row = conn.execute("SELECT * FROM admins WHERE username = ?", (username,)).fetchone()
    conn.close()

    if not row or not check_password_hash(row["password_hash"], password):
        _register_failure(ip)
        return jsonify({"error": "Invalid username or password"}), 401

    _register_success(ip)
    session.clear()
    session["admin_id"] = row["id"]
    session["username"] = row["username"]
    return jsonify({"ok": True, "username": row["username"]})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
def me():
    if session.get("admin_id"):
        return jsonify({"loggedIn": True, "username": session.get("username")})
    return jsonify({"loggedIn": False})


# ---- tracks API -----------------------------------------------------------------
@app.get("/api/tracks")
def list_tracks():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM tracks WHERE active = 1 ORDER BY sort_order ASC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.delete("/api/tracks/<track_id>")
@login_required
def delete_track(track_id):
    conn = get_db()
    row = conn.execute("SELECT src FROM tracks WHERE id = ?", (track_id,)).fetchone()
    conn.execute("UPDATE tracks SET active = 0 WHERE id = ?", (track_id,))
    conn.commit()
    conn.close()
    # Uploaded videos are stored under unique-per-upload filenames, so it's safe to
    # remove the file from disk once its track is delisted — nothing else references it.
    # (Soft-delete only flips `active`; without this the persistent disk fills up with
    # orphaned video files from every replaced/removed upload.)
    if row and row["src"] and row["src"].startswith("videos/"):
        _delete_video_file_if_unreferenced(row["src"])
    return jsonify({"ok": True})


def _delete_video_file_if_unreferenced(src):
    conn = get_db()
    still_used = conn.execute(
        "SELECT COUNT(*) FROM tracks WHERE src = ? AND active = 1", (src,)
    ).fetchone()[0]
    conn.close()
    if still_used:
        return
    filename = src.split("/", 1)[-1]
    path = VIDEOS_DIR / filename
    try:
        if path.is_file():
            path.unlink()
    except OSError:
        pass


@app.post("/api/tracks")
@login_required
def add_track():
    data = request.get_json(silent=True) or {}
    track_type = data.get("type")
    if track_type not in ("youtube", "tiktok", "apple"):
        return jsonify({"error": "unsupported type"}), 400

    conn = get_db()
    next_order = (conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM tracks").fetchone()[0])
    new_id = f"{track_type}-{secrets.token_hex(4)}"
    conn.execute(
        "INSERT INTO tracks (id, title, artist, len, seconds, type, embed_id, embed_url, sort_order) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (
            new_id,
            data.get("title", "Imported Track"),
            data.get("artist", "Imported Link"),
            "--:--",
            0,
            track_type,
            data.get("id"),
            data.get("embedUrl"),
            next_order,
        ),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "id": new_id})


def _video_duration_seconds(path, attempts=6, delay=0.5):
    """Best-effort duration lookup via macOS Spotlight metadata (mdls).
    Spotlight indexes a file asynchronously right after it's written, so a
    lookup immediately after save() often comes back empty — retry briefly
    before giving up. Returns 0 if still unknown after all attempts.
    """
    for _ in range(attempts):
        try:
            out = subprocess.run(
                ["mdls", "-name", "kMDItemDurationSeconds", "-raw", str(path)],
                capture_output=True, text=True, timeout=10,
            ).stdout.strip()
            if out and out != "(null)":
                return float(out)
        except (subprocess.SubprocessError, ValueError, FileNotFoundError):
            pass
        time.sleep(delay)
    return 0


def _format_len(seconds):
    if not seconds or seconds <= 0:
        return "--:--"
    seconds = int(round(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


@app.post("/api/tracks/upload")
@login_required
def upload_track():
    file = request.files.get("video")
    if not file or not file.filename:
        return jsonify({"error": "No file uploaded."}), 400

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        return jsonify({"error": f"Unsupported file type .{ext}. Allowed: {', '.join(sorted(ALLOWED_VIDEO_EXTENSIONS))}"}), 400

    base_name = secure_filename(file.filename.rsplit(".", 1)[0]) or "video"
    filename = f"{base_name}-{secrets.token_hex(4)}.{ext}"
    dest = VIDEOS_DIR / filename
    file.save(dest)

    seconds = _video_duration_seconds(dest)
    title = (request.form.get("title") or base_name.replace("-", " ").replace("_", " ").title()).strip()
    artist = (request.form.get("artist") or "Kingdom Stores").strip()

    conn = get_db()
    next_order = (conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM tracks").fetchone()[0])
    new_id = f"video-{secrets.token_hex(4)}"
    conn.execute(
        "INSERT INTO tracks (id, title, artist, len, seconds, src, type, sort_order) VALUES (?,?,?,?,?,?,?,?)",
        (new_id, title, artist, _format_len(seconds), int(seconds), f"videos/{filename}", "video", next_order),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "id": new_id, "title": title, "artist": artist})


@app.errorhandler(413)
def too_large(e):
    return jsonify({"error": "That file is too large (300MB limit)."}), 413


@app.get("/api/admin/disk-report")
@login_required
def disk_report():
    """Diagnostic: which video files on disk are/aren't referenced by a track row,
    and by an *active* track row. Read-only, admin-only."""
    conn = get_db()
    rows = conn.execute("SELECT id, title, active, src FROM tracks").fetchall()
    conn.close()

    referenced = {r["src"] for r in rows if r["src"]}
    referenced_active = {r["src"] for r in rows if r["src"] and r["active"]}

    files = []
    total_bytes = 0
    if VIDEOS_DIR.exists():
        for p in sorted(VIDEOS_DIR.iterdir()):
            if not p.is_file():
                continue
            size = p.stat().st_size
            total_bytes += size
            rel = f"videos/{p.name}"
            files.append({
                "name": p.name,
                "size_mb": round(size / 1024 / 1024, 2),
                "referenced": rel in referenced,
                "referenced_by_active_track": rel in referenced_active,
            })
    files.sort(key=lambda f: -f["size_mb"])

    disk_total, disk_used, disk_free = shutil.disk_usage(str(VIDEOS_DIR))

    return jsonify({
        "video_file_count": len(files),
        "video_dir_total_mb": round(total_bytes / 1024 / 1024, 2),
        "disk_total_mb": round(disk_total / 1024 / 1024, 2),
        "disk_used_mb": round(disk_used / 1024 / 1024, 2),
        "disk_free_mb": round(disk_free / 1024 / 1024, 2),
        "tracks": [dict(r) for r in rows],
        "files": files,
    })


@app.post("/api/admin/cleanup-orphaned-videos")
@login_required
def cleanup_orphaned_videos():
    """Free disk space by deleting video files that no *active* track references —
    i.e. files left behind by past uploads that were later replaced/delisted (soft
    delete never removed the file) or that never finished being recorded in the DB.
    Never touches a file referenced by a currently-active track."""
    conn = get_db()
    rows = conn.execute("SELECT src FROM tracks WHERE active = 1 AND src IS NOT NULL").fetchall()
    conn.close()
    active_files = {r["src"].split("/", 1)[-1] for r in rows if r["src"] and r["src"].startswith("videos/")}

    deleted = []
    freed_bytes = 0
    if VIDEOS_DIR.exists():
        for p in VIDEOS_DIR.iterdir():
            if not p.is_file() or p.name in active_files:
                continue
            size = p.stat().st_size
            try:
                p.unlink()
            except OSError:
                continue
            deleted.append(p.name)
            freed_bytes += size

    return jsonify({
        "ok": True,
        "deleted_files": deleted,
        "freed_mb": round(freed_bytes / 1024 / 1024, 2),
    })


# ---- live streaming API ------------------------------------------------------------
@app.get("/api/live/sessions")
def api_list_live_sessions():
    status = request.args.get("status")
    rows = list_live_sessions(status=status)
    return jsonify([dict(r) for r in rows])


@app.post("/api/live/sessions")
@login_required
def api_create_live_session():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Title is required."}), 400
    host_name = (data.get("host_name") or session.get("username") or "Kingdom Stores").strip()
    session_id, room_code = create_live_session(title, host_name)
    return jsonify({"ok": True, "id": session_id, "room_code": room_code})


# ---- products API -----------------------------------------------------------------
@app.get("/api/products")
def list_products():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.delete("/api/products/<product_id>")
@login_required
def delete_product(product_id):
    conn = get_db()
    conn.execute("UPDATE products SET active = 0 WHERE id = ?", (product_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.patch("/api/products/<product_id>/price")
@login_required
def update_product_price(product_id):
    data = request.get_json(silent=True) or {}
    cents = parse_price_to_cents(data.get("price"))
    if cents is None:
        return jsonify({"error": "Enter a valid, non-negative price."}), 400

    conn = get_db()
    row = conn.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Product not found."}), 404
    display = f"${cents / 100:,.2f}"
    conn.execute(
        "UPDATE products SET price = ?, price_cents = ? WHERE id = ?",
        (display, cents, product_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "price": display, "price_cents": cents})


# ---- apparel (physical merch: tshirt / hoodie / hat) -------------------------------
@app.get("/api/apparel")
def list_apparel():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM apparel WHERE active = 1 ORDER BY category ASC, sort_order ASC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.post("/api/apparel")
@login_required
def add_apparel():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    category = (data.get("category") or "").strip().lower()
    image_path = (data.get("image_path") or "").strip()
    if not name or category not in ("tshirt", "hoodie", "hat") or not image_path:
        return jsonify({"error": "name, category (tshirt/hoodie/hat), and image_path are required."}), 400
    cents = parse_price_to_cents(data.get("price", "0"))
    if cents is None:
        return jsonify({"error": "Enter a valid, non-negative price."}), 400

    conn = get_db()
    next_order = (conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM apparel").fetchone()[0])
    new_id = f"{category}-{secrets.token_hex(4)}"
    conn.execute(
        "INSERT INTO apparel (id, name, category, price, price_cents, image_path, sort_order) VALUES (?,?,?,?,?,?,?)",
        (new_id, name, category, f"${cents / 100:,.2f}", cents, image_path, next_order),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "id": new_id})


@app.delete("/api/apparel/<item_id>")
@login_required
def delete_apparel(item_id):
    conn = get_db()
    conn.execute("UPDATE apparel SET active = 0 WHERE id = ?", (item_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.patch("/api/apparel/<item_id>/price")
@login_required
def update_apparel_price(item_id):
    data = request.get_json(silent=True) or {}
    cents = parse_price_to_cents(data.get("price"))
    if cents is None:
        return jsonify({"error": "Enter a valid, non-negative price."}), 400

    conn = get_db()
    row = conn.execute("SELECT id FROM apparel WHERE id = ?", (item_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Item not found."}), 404
    display = f"${cents / 100:,.2f}"
    conn.execute(
        "UPDATE apparel SET price = ?, price_cents = ? WHERE id = ?",
        (display, cents, item_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "price": display, "price_cents": cents})


# ---- subscribers (opt-in visitor outreach list) -----------------------------------
import re

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@app.post("/api/subscribe")
def subscribe():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not _EMAIL_RE.match(email):
        return jsonify({"error": "Enter a valid email address."}), 400

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO subscribers (email, source) VALUES (?, ?)",
            (email, data.get("source", "site")),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        # Already subscribed — treat as success so we don't leak who's on the list.
        pass
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/subscribers")
@login_required
def list_subscribers():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, email, source, created_at FROM subscribers WHERE active = 1 ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.delete("/api/subscribers/<int:subscriber_id>")
@login_required
def delete_subscriber(subscriber_id):
    conn = get_db()
    conn.execute("UPDATE subscribers SET active = 0 WHERE id = ?", (subscriber_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---- checkout (Stripe) --------------------------------------------------------------
# Inactive until STRIPE_SECRET_KEY is set in backend/.env — calls return 501 until then,
# never a fake "success" so nothing here can be mistaken for a real, working checkout.
def _stripe_configured():
    return bool(STRIPE_SECRET_KEY)


@app.post("/api/checkout")
def create_checkout_session():
    if not _stripe_configured():
        return jsonify({
            "error": "Checkout isn't live yet — Stripe isn't configured. "
                     "Set STRIPE_SECRET_KEY in backend/.env to enable it."
        }), 501

    data = request.get_json(silent=True) or {}
    item_ids = data.get("items") or []
    if not item_ids:
        return jsonify({"error": "No items provided."}), 400

    conn = get_db()
    placeholders = ",".join("?" for _ in item_ids)
    rows = conn.execute(
        f"""
        SELECT id, name, price_cents, is_physical FROM products WHERE id IN ({placeholders}) AND active = 1
        UNION ALL
        SELECT id, name, price_cents, 1 AS is_physical FROM apparel WHERE id IN ({placeholders}) AND active = 1
        """,
        item_ids + item_ids,
    ).fetchall()
    conn.close()

    if not rows:
        return jsonify({"error": "None of those products are available."}), 400

    line_items = [
        {
            "price_data": {
                "currency": "usd",
                "product_data": {"name": row["name"]},
                "unit_amount": row["price_cents"],
            },
            "quantity": 1,
        }
        for row in rows
    ]
    needs_shipping = any(row["is_physical"] for row in rows)
    amount_total = sum(row["price_cents"] for row in rows)

    site_url = request.host_url.rstrip("/")
    session_kwargs = dict(
        mode="payment",
        line_items=line_items,
        success_url=f"{site_url}/?checkout=success",
        cancel_url=f"{site_url}/?checkout=cancelled",
    )
    if needs_shipping:
        session_kwargs["shipping_address_collection"] = {"allowed_countries": ["US"]}

    try:
        checkout_session = stripe.checkout.Session.create(**session_kwargs)
    except stripe.error.StripeError as e:
        return jsonify({"error": str(e)}), 502

    conn = get_db()
    conn.execute(
        "INSERT INTO orders (id, stripe_session_id, items, amount_total, status) VALUES (?,?,?,?,?)",
        (
            f"ord_{secrets.token_hex(8)}",
            checkout_session.id,
            json.dumps([row["id"] for row in rows]),
            amount_total,
            "pending",
        ),
    )
    conn.commit()
    conn.close()

    return jsonify({"url": checkout_session.url})


@app.post("/api/webhooks/stripe")
def stripe_webhook():
    if not _stripe_configured() or not STRIPE_WEBHOOK_SECRET:
        return jsonify({"error": "Webhook not configured."}), 501

    payload = request.data
    sig_header = request.headers.get("Stripe-Signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        return jsonify({"error": "Invalid webhook signature."}), 400

    if event["type"] == "checkout.session.completed":
        obj = event["data"]["object"]
        conn = get_db()
        shipping_details = obj.get("shipping_details") or {}
        conn.execute(
            """UPDATE orders SET status = 'paid', customer_email = ?,
               shipping_name = ?, shipping_address = ? WHERE stripe_session_id = ?""",
            (
                obj.get("customer_details", {}).get("email"),
                shipping_details.get("name"),
                json.dumps(shipping_details.get("address")) if shipping_details.get("address") else None,
                obj["id"],
            ),
        )
        conn.commit()
        conn.close()

    return jsonify({"received": True})


# ---- orders (admin) ------------------------------------------------------------------
@app.get("/api/orders")
@login_required
def list_orders():
    conn = get_db()
    rows = conn.execute("SELECT * FROM orders ORDER BY created_at DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.get("/api/orders/<order_id>/shipping-rates")
@login_required
def order_shipping_rates(order_id):
    conn = get_db()
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    conn.close()
    if not order:
        return jsonify({"error": "Order not found."}), 404
    if not order["shipping_address"]:
        return jsonify({"error": "This order has no shipping address on file."}), 400

    try:
        address = json.loads(order["shipping_address"])
        address_to = {
            "name": order["shipping_name"] or "",
            "street1": address.get("line1", ""),
            "city": address.get("city", ""),
            "state": address.get("state", ""),
            "zip": address.get("postal_code", ""),
            "country": address.get("country", "US"),
        }
        # Placeholder parcel dims — replace with real per-product package sizes
        # once physical merchandise is added to the catalog.
        parcel = {"length": "10", "width": "8", "height": "4", "distance_unit": "in",
                   "weight": "1", "mass_unit": "lb"}
        rates = shipping.get_rates(address_to, parcel)
    except shipping.ShippingNotConfigured as e:
        return jsonify({"error": str(e)}), 501

    return jsonify(rates)


@app.post("/api/orders/<order_id>/ship")
@login_required
def order_ship(order_id):
    data = request.get_json(silent=True) or {}
    rate_id = data.get("rate_id")
    if not rate_id:
        return jsonify({"error": "rate_id is required (pick one from /shipping-rates first)."}), 400

    try:
        label = shipping.buy_label(rate_id)
    except shipping.ShippingNotConfigured as e:
        return jsonify({"error": str(e)}), 501

    conn = get_db()
    conn.execute(
        """UPDATE orders SET status = 'shipped', carrier = ?, tracking_number = ?,
           shipping_label_url = ? WHERE id = ?""",
        (label.get("carrier"), label.get("tracking_number"), label.get("label_url"), order_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, **label})


# ==================================================================
# Socket.IO — live chat, WebRTC signaling relay, camera-join workflow.
# Pure relay: the server never touches media, only forwards SDP/ICE JSON
# and chat text by socket id / room. Ported from the Msanii Media reference
# implementation essentially as-is.
# ==================================================================
@socketio.on("join_room")
def on_join_room(data):
    room_code = data.get("room")
    role = data.get("role", "viewer")  # 'host' | 'viewer'
    name = data.get("name", "Guest")
    if not room_code:
        return
    join_room(room_code)
    live_session = get_live_session_by_room(room_code)
    if live_session:
        history = [dict(m) for m in list_chat_messages(live_session["id"])]
        emit("chat_history", {"messages": history})
    emit("presence", {"role": role, "name": name, "sid": request.sid}, to=room_code, include_self=False)


@socketio.on("chat_message")
def on_chat_message(data):
    room_code = data.get("room")
    name = data.get("name", "Guest")
    message = (data.get("message") or "").strip()
    if not room_code or not message:
        return
    live_session = get_live_session_by_room(room_code)
    if not live_session:
        return
    add_chat_message(live_session["id"], name, message)
    emit("chat_message", {"name": name, "message": message}, to=room_code)


@socketio.on("host_go_live")
def on_host_go_live(data):
    room_code = data.get("room")
    live_session = get_live_session_by_room(room_code)
    if not live_session:
        return
    set_live_status(live_session["id"], "live")
    emit("live_status", {"status": "live"}, to=room_code)


@socketio.on("host_end_live")
def on_host_end_live(data):
    room_code = data.get("room")
    live_session = get_live_session_by_room(room_code)
    if not live_session:
        return
    set_live_status(live_session["id"], "ended")
    emit("live_status", {"status": "ended"}, to=room_code)


@socketio.on("camera_offer")
def on_camera_offer(data):
    # Viewer sends its WebRTC offer up front (not after approval) so the host
    # can preview their live camera/mic before deciding -- this event carries
    # both the join request and the SDP that used to arrive separately, later,
    # only once approved.
    room_code = data.get("room")
    name = data.get("name", "Guest")
    sdp = data.get("sdp")
    if not sdp:
        return
    live_session = get_live_session_by_room(room_code)
    if not live_session:
        return
    req_id = create_camera_request(live_session["id"], name, request.sid)
    emit(
        "camera_offer",
        {"request_id": req_id, "name": name, "sdp": sdp, "socket_id": request.sid},
        to=room_code,
        include_self=False,
    )


@socketio.on("respond_camera")
def on_respond_camera(data):
    room_code = data.get("room")
    request_id = data.get("request_id")
    approve = bool(data.get("approve"))
    req = get_camera_request(request_id)
    if not req:
        return
    set_camera_request_status(request_id, "approved" if approve else "denied")
    emit(
        "camera_response",
        {"request_id": request_id, "approve": approve, "host_sid": request.sid},
        to=req["socket_id"],
    )
    if approve:
        emit("guest_joining", {"socket_id": req["socket_id"], "name": req["viewer_name"]}, to=room_code)


# ---- WebRTC signaling relay (direct socket-to-socket, not room broadcast) ----
@socketio.on("webrtc_signal")
def on_webrtc_signal(data):
    target_sid = data.get("to")
    if not target_sid:
        return
    payload = dict(data)
    payload["from"] = request.sid
    emit("webrtc_signal", payload, to=target_sid)


# Runs on import too (not just `python app.py`), so gunicorn/Passenger — which import
# this module and call `app` directly, never executing the block below — still get an
# initialized database.
init_db()

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", 8843))
    socketio.run(app, host=host, port=port, debug=False, allow_unsafe_werkzeug=True)
