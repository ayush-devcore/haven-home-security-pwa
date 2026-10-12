import json
import logging
import os
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from uuid import uuid4

import jwt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from pwdlib import PasswordHash

try:
    from pywebpush import webpush
except ImportError:  # The API can still run before push dependencies are installed.
    webpush = None

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

DATABASE_PATH = BASE_DIR / "haven.db"
DEVICE_TOKEN = os.getenv("HAVEN_DEVICE_TOKEN", "")
JWT_SECRET = os.getenv("JWT_SECRET", "")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_MINUTES = 30
SIMULATOR_ENABLED = os.getenv("HAVEN_ENABLE_SIMULATOR", "true").strip().lower() in {
    "1", "true", "yes", "on"
}
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "").strip()
_vapid_private_raw = os.getenv("VAPID_PRIVATE_KEY_PATH", "vapid_private.pem").strip()
VAPID_PRIVATE_KEY_PATH = Path(_vapid_private_raw)
if not VAPID_PRIVATE_KEY_PATH.is_absolute():
    VAPID_PRIVATE_KEY_PATH = BASE_DIR / VAPID_PRIVATE_KEY_PATH
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:haven-admin@example.com").strip()
logger = logging.getLogger("haven.push")

password_hasher = PasswordHash.recommended()
bearer_scheme = HTTPBearer(auto_error=False)

DeviceEventType = Literal[
    "motion_detected",
    "door_opened",
    "alarm_triggered",
    "device_online",
    "device_offline",
]
EventType = Literal[
    "motion_detected",
    "door_opened",
    "alarm_triggered",
    "device_online",
    "device_offline",
    "system_armed",
    "system_disarmed",
]
SimulatorEventType = Literal[
    "motion_detected",
    "door_opened",
    "alarm_triggered",
    "device_online",
    "device_offline",
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def initialize_database() -> None:
    """Create missing tables without deleting existing events or users."""
    with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS security_events (
                id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                device_id TEXT NOT NULL,
                message TEXT NOT NULL,
                received_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS system_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                armed INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO system_state (id, armed, updated_at)
            VALUES (1, 0, ?)
            """,
            (utc_now().isoformat(),),
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                endpoint TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_username "
            "ON push_subscriptions(username)"
        )
        connection.commit()


initialize_database()

app = FastAPI(
    title="Haven Home Security API",
    description=(
        "Authenticated API for Haven. Includes persistent software arm/disarm "
        "controls and an explicitly labelled event simulator."
    ),
    version="0.6.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "https://haven-home-security-pwa.netlify.app",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Device-Token"],
)


class RegisterRequest(BaseModel):
    username: str = Field(
        min_length=3,
        max_length=32,
        pattern=r"^[a-zA-Z0-9_.-]+$",
    )
    password: str = Field(min_length=12, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=128)


class SecurityEventIn(BaseModel):
    event_type: DeviceEventType
    device_id: str = Field(default="esp32-main", min_length=1, max_length=64)
    message: str = Field(min_length=1, max_length=200)


class SecurityEventRecord(BaseModel):
    id: str
    event_type: EventType
    device_id: str
    message: str
    received_at: datetime


class ArmRequest(BaseModel):
    armed: bool


class SimulationRequest(BaseModel):
    event_type: SimulatorEventType
    message: str | None = Field(default=None, min_length=1, max_length=160)


class SystemStatus(BaseModel):
    armed: bool
    updated_at: datetime
    mode: Literal["software-only"] = "software-only"
    hardware_connected: bool = False


class PushSubscriptionKeys(BaseModel):
    p256dh: str = Field(min_length=8, max_length=512)
    auth: str = Field(min_length=8, max_length=512)


class PushSubscriptionIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=4096)
    keys: PushSubscriptionKeys


class PushUnsubscribeIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=4096)


def push_is_configured() -> bool:
    return bool(
        webpush is not None
        and VAPID_PUBLIC_KEY
        and VAPID_PRIVATE_KEY_PATH.is_file()
        and (VAPID_SUBJECT.startswith("mailto:") or VAPID_SUBJECT.startswith("https://"))
    )


def event_push_payload(event: SecurityEventRecord) -> dict:
    labels = {
        "motion_detected": "Motion detected",
        "door_opened": "Door opened",
        "alarm_triggered": "Alarm triggered",
        "device_online": "Device online",
        "device_offline": "Device offline",
        "system_armed": "Haven armed",
        "system_disarmed": "Haven disarmed",
    }
    return {
        "title": f"Haven: {labels.get(event.event_type, 'Security update')}",
        "body": event.message[:180],
        "url": "/",
        "tag": f"haven-{event.id}",
    }


def send_push_to_user(username: str, payload: dict) -> tuple[int, int]:
    """Best-effort push delivery; notification failures never roll back saved events."""
    if not push_is_configured():
        return 0, 0

    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            connection.row_factory = sqlite3.Row
            subscriptions = connection.execute(
                "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE username = ?",
                (username,),
            ).fetchall()
    except sqlite3.Error:
        logger.warning("Could not read push subscriptions for delivery")
        return 0, 0

    sent = 0
    failed = 0
    for subscription in subscriptions:
        try:
            webpush(
                subscription_info={
                    "endpoint": subscription["endpoint"],
                    "keys": {
                        "p256dh": subscription["p256dh"],
                        "auth": subscription["auth"],
                    },
                },
                data=json.dumps(payload),
                vapid_private_key=str(VAPID_PRIVATE_KEY_PATH),
                vapid_claims={"sub": VAPID_SUBJECT},
                ttl=60,
            )
            sent += 1
        except Exception as exc:
            failed += 1
            response = getattr(exc, "response", None)
            status_code = getattr(response, "status_code", None)
            if status_code in (404, 410):
                try:
                    with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
                        connection.execute(
                            "DELETE FROM push_subscriptions WHERE endpoint = ?",
                            (subscription["endpoint"],),
                        )
                        connection.commit()
                except sqlite3.Error:
                    logger.warning("Could not remove an expired push subscription")
            logger.warning("Web push delivery failed (status=%s)", status_code or "unknown")
    return sent, failed


def send_push_to_all_users(payload: dict) -> tuple[int, int]:
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            usernames = [
                row[0] for row in connection.execute(
                    "SELECT DISTINCT username FROM push_subscriptions"
                ).fetchall()
            ]
    except sqlite3.Error:
        logger.warning("Could not list push subscribers")
        return 0, 0

    sent = failed = 0
    for username in usernames:
        user_sent, user_failed = send_push_to_user(username, payload)
        sent += user_sent
        failed += user_failed
    return sent, failed



def get_user(username: str):
    with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
        connection.row_factory = sqlite3.Row
        return connection.execute(
            """
            SELECT username, password_hash
            FROM users
            WHERE username = ?
            """,
            (username,),
        ).fetchone()


def issue_access_token(username: str) -> dict:
    if len(JWT_SECRET) < 32:
        raise HTTPException(
            status_code=503,
            detail="JWT signing secret is missing or too short",
        )

    now = utc_now()
    expires_at = now + timedelta(minutes=ACCESS_TOKEN_MINUTES)
    token = jwt.encode(
        {"sub": username, "iat": now, "exp": expires_at},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_MINUTES * 60,
    }


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Sign in to access this resource",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if len(JWT_SECRET) < 32:
        raise HTTPException(
            status_code=503,
            detail="JWT authentication is not configured",
        )

    try:
        payload = jwt.decode(
            credentials.credentials,
            JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
        )
        username = payload.get("sub")
        if not isinstance(username, str) or not username:
            raise jwt.InvalidTokenError("Missing subject")
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    user = get_user(username)
    if user is None:
        raise HTTPException(
            status_code=401,
            detail="Account no longer exists",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return {"username": user["username"]}


def require_device_token(
    x_device_token: str | None = Header(default=None, alias="X-Device-Token"),
) -> None:
    if not DEVICE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="Device authentication is not configured",
        )
    if x_device_token is None or not secrets.compare_digest(
        x_device_token, DEVICE_TOKEN
    ):
        raise HTTPException(status_code=401, detail="Missing or invalid device token")


def insert_event(
    connection: sqlite3.Connection,
    event_type: EventType,
    device_id: str,
    message: str,
    received_at: datetime | None = None,
) -> SecurityEventRecord:
    timestamp = received_at or utc_now()
    event = SecurityEventRecord(
        id=str(uuid4()),
        event_type=event_type,
        device_id=device_id,
        message=message,
        received_at=timestamp,
    )
    connection.execute(
        """
        INSERT INTO security_events (id, event_type, device_id, message, received_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            event.id,
            event.event_type,
            event.device_id,
            event.message,
            event.received_at.isoformat(),
        ),
    )
    return event


def read_system_status(connection: sqlite3.Connection) -> SystemStatus:
    connection.row_factory = sqlite3.Row
    row = connection.execute(
        "SELECT armed, updated_at FROM system_state WHERE id = 1"
    ).fetchone()
    if row is None:
        timestamp = utc_now()
        connection.execute(
            "INSERT INTO system_state (id, armed, updated_at) VALUES (1, 0, ?)",
            (timestamp.isoformat(),),
        )
        connection.commit()
        return SystemStatus(armed=False, updated_at=timestamp)
    return SystemStatus(
        armed=bool(row["armed"]),
        updated_at=row["updated_at"],
    )


@app.get("/")
def root():
    return {"name": "Haven Home Security API", "status": "running", "version": "0.6.0"}


@app.get("/health")
def health():
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            connection.execute("SELECT 1").fetchone()
        return {
            "status": "healthy",
            "service": "haven-api",
            "database": "connected",
            "timestamp": utc_now().isoformat(),
        }
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Database unavailable") from exc


@app.post("/api/auth/register", status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest):
    """Create the first local account. Extra registrations are disabled for now."""
    username = payload.username.strip().lower()
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            user_count = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            if user_count > 0:
                raise HTTPException(status_code=403, detail="Initial registration is closed")
            password_hash = password_hasher.hash(payload.password)
            connection.execute(
                """
                INSERT INTO users (username, password_hash, created_at)
                VALUES (?, ?, ?)
                """,
                (username, password_hash, utc_now().isoformat()),
            )
            connection.commit()
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Unable to create this account") from exc

    return {"username": username, "message": "Account created. Sign in to continue."}


@app.post("/api/auth/login")
def login(payload: LoginRequest):
    username = payload.username.strip().lower()
    user = get_user(username)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    try:
        password_ok = password_hasher.verify(payload.password, user["password_hash"])
    except Exception:
        password_ok = False
    if not password_ok:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return issue_access_token(username)


@app.get("/api/auth/me")
def get_me(current_user: dict = Depends(get_current_user)):
    return current_user


@app.get("/api/system/status", response_model=SystemStatus)
def get_system_status(current_user: dict = Depends(get_current_user)):
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            return read_system_status(connection)
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to retrieve system status") from exc


@app.post("/api/system/arm", response_model=SystemStatus)
def set_system_armed(
    payload: ArmRequest,
    current_user: dict = Depends(get_current_user),
):
    event_for_push: SecurityEventRecord | None = None
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT armed FROM system_state WHERE id = 1"
            ).fetchone()
            previous_armed = bool(current["armed"]) if current else False
            timestamp = utc_now()

            if current is None:
                connection.execute(
                    "INSERT INTO system_state (id, armed, updated_at) VALUES (1, ?, ?)",
                    (int(payload.armed), timestamp.isoformat()),
                )
            elif previous_armed != payload.armed:
                connection.execute(
                    "UPDATE system_state SET armed = ?, updated_at = ? WHERE id = 1",
                    (int(payload.armed), timestamp.isoformat()),
                )
                event_type: EventType = (
                    "system_armed" if payload.armed else "system_disarmed"
                )
                description = (
                    "Haven armed in software-only mode."
                    if payload.armed
                    else "Haven disarmed in software-only mode."
                )
                event_for_push = insert_event(
                    connection,
                    event_type,
                    "haven-software",
                    f"[SOFTWARE] {description} Physical hardware was not controlled.",
                    timestamp,
                )
            connection.commit()
            resulting_status = read_system_status(connection)
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to update system state") from exc

    if event_for_push is not None:
        send_push_to_user(current_user["username"], event_push_payload(event_for_push))
    return resulting_status


@app.post("/api/simulator/trigger")
def trigger_simulated_event(
    payload: SimulationRequest,
    current_user: dict = Depends(get_current_user),
):
    if not SIMULATOR_ENABLED:
        raise HTTPException(status_code=404, detail="Software simulator is disabled")

    labels = {
        "motion_detected": "Motion detected",
        "door_opened": "Door opened",
        "alarm_triggered": "Alarm triggered",
        "device_online": "Device online",
        "device_offline": "Device offline",
    }
    user_message = payload.message or (
        f"{labels[payload.event_type]} generated by the Haven software simulator."
    )
    safe_message = f"[SIMULATED] {user_message}"

    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            armed_row = connection.execute(
                "SELECT armed FROM system_state WHERE id = 1"
            ).fetchone()
            is_armed = bool(armed_row[0]) if armed_row else False

            created_events = [
                insert_event(
                    connection,
                    payload.event_type,
                    "software-simulator",
                    safe_message,
                )
            ]

            # Intrusion simulations escalate to a simulated alarm only while armed.
            if is_armed and payload.event_type in {"motion_detected", "door_opened"}:
                created_events.append(
                    insert_event(
                        connection,
                        "alarm_triggered",
                        "haven-software",
                        "[SIMULATED] Alarm escalation: intrusion event while Haven was armed. No physical alarm was activated.",
                    )
                )
            connection.commit()

        for event in created_events:
            send_push_to_user(current_user["username"], event_push_payload(event))

        return {
            "simulation": True,
            "system_armed": is_armed,
            "events_created": [event.model_dump(mode="json") for event in created_events],
            "message": "Simulated events saved. No physical hardware was controlled.",
        }
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to save simulated event") from exc


@app.get("/api/push/status")
def get_push_status(current_user: dict = Depends(get_current_user)):
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM push_subscriptions WHERE username = ?",
                (current_user["username"],),
            ).fetchone()[0]
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to read push status") from exc
    return {
        "configured": push_is_configured(),
        "subscribed": count > 0,
        "subscription_count": count,
    }


@app.get("/api/push/public-key")
def get_push_public_key(current_user: dict = Depends(get_current_user)):
    if not push_is_configured():
        raise HTTPException(
            status_code=503,
            detail="Web push is not configured. Install pywebpush and generate VAPID keys first.",
        )
    return {"public_key": VAPID_PUBLIC_KEY}


@app.post("/api/push/subscribe")
def subscribe_to_push(
    payload: PushSubscriptionIn,
    current_user: dict = Depends(get_current_user),
):
    if not push_is_configured():
        raise HTTPException(status_code=503, detail="Web push is not configured yet")
    if not payload.endpoint.startswith("https://"):
        raise HTTPException(status_code=422, detail="Push endpoint must use HTTPS")
    timestamp = utc_now().isoformat()
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            connection.execute(
                """
                INSERT INTO push_subscriptions
                    (endpoint, username, p256dh, auth, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET
                    username = excluded.username,
                    p256dh = excluded.p256dh,
                    auth = excluded.auth,
                    updated_at = excluded.updated_at
                """,
                (
                    payload.endpoint, current_user["username"],
                    payload.keys.p256dh, payload.keys.auth, timestamp, timestamp,
                ),
            )
            connection.commit()
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to save push subscription") from exc
    return {"subscribed": True, "message": "Browser push subscription saved."}


@app.post("/api/push/unsubscribe")
def unsubscribe_from_push(
    payload: PushUnsubscribeIn,
    current_user: dict = Depends(get_current_user),
):
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            connection.execute(
                "DELETE FROM push_subscriptions WHERE username = ? AND endpoint = ?",
                (current_user["username"], payload.endpoint),
            )
            connection.commit()
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to remove push subscription") from exc
    return {"subscribed": False, "message": "Browser push subscription removed."}


@app.post("/api/push/test")
def test_push(current_user: dict = Depends(get_current_user)):
    if not push_is_configured():
        raise HTTPException(status_code=503, detail="Web push is not configured yet")
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM push_subscriptions WHERE username = ?",
                (current_user["username"],),
            ).fetchone()[0]
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to check push subscriptions") from exc
    if not count:
        raise HTTPException(status_code=409, detail="Enable browser push notifications first")

    sent, failed = send_push_to_user(
        current_user["username"],
        {
            "title": "Haven test notification",
            "body": "Push delivery is connected. This is a test; no hardware was activated.",
            "url": "/",
            "tag": "haven-test-notification",
        },
    )
    if sent == 0:
        raise HTTPException(
            status_code=502,
            detail="Push delivery failed. Check the VAPID configuration and browser subscription.",
        )
    return {"sent": sent, "failed": failed, "message": "Test push notification sent."}


@app.post(
    "/api/events",
    response_model=SecurityEventRecord,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_device_token)],
)
def create_event(payload: SecurityEventIn):
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            event = insert_event(
                connection,
                payload.event_type,
                payload.device_id,
                payload.message,
            )
            connection.commit()
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to save security event") from exc

    # Hardware-originated events notify every account with an active subscription.
    send_push_to_all_users(event_push_payload(event))
    return event


@app.get("/api/events", response_model=list[SecurityEventRecord])
def get_events(current_user: dict = Depends(get_current_user)):
    try:
        with closing(sqlite3.connect(DATABASE_PATH, timeout=5)) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                """
                SELECT id, event_type, device_id, message, received_at
                FROM security_events
                ORDER BY received_at DESC
                LIMIT 100
                """
            ).fetchall()
        return [dict(row) for row in rows]
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to retrieve security events") from exc
