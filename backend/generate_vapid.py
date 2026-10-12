"""Create (or reuse) local VAPID keys and update backend/.env safely."""
from __future__ import annotations

import base64
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

BASE_DIR = Path(__file__).resolve().parent
ENV_FILE = BASE_DIR / ".env"
PRIVATE_KEY_FILE = BASE_DIR / "vapid_private.pem"
ENV_VALUES = {
    "VAPID_PRIVATE_KEY_PATH": "vapid_private.pem",
}


def read_env_value(text: str, key: str) -> str | None:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(f"{key}="):
            return stripped.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def update_env(path: Path, updates: dict[str, str]) -> None:
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = existing.splitlines()
    written: set[str] = set()
    output: list[str] = []
    for line in lines:
        stripped = line.strip()
        matched = next((key for key in updates if stripped.startswith(f"{key}=")), None)
        if matched is not None:
            if matched not in written:
                output.append(f"{matched}={updates[matched]}")
                written.add(matched)
        else:
            output.append(line)
    for key, value in updates.items():
        if key not in written:
            output.append(f"{key}={value}")
    path.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")


def public_key_b64url(private_key: ec.EllipticCurvePrivateKey) -> str:
    raw_public = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return base64.urlsafe_b64encode(raw_public).decode("ascii").rstrip("=")


def main() -> None:
    env_text = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ""
    existing_subject = read_env_value(env_text, "VAPID_SUBJECT")
    subject = input(
        "VAPID contact (mailto:you@example.com) [mailto:haven-admin@example.com]: "
    ).strip()
    if not subject:
        subject = existing_subject or "mailto:haven-admin@example.com"
    if not (subject.startswith("mailto:") or subject.startswith("https://")):
        raise SystemExit("Contact must begin with mailto: or https://")

    if PRIVATE_KEY_FILE.exists():
        private_key = serialization.load_pem_private_key(
            PRIVATE_KEY_FILE.read_bytes(), password=None
        )
        if not isinstance(private_key, ec.EllipticCurvePrivateKey) or not isinstance(
            private_key.curve, ec.SECP256R1
        ):
            raise SystemExit("Existing VAPID private key is not a P-256 EC key; refusing to overwrite it.")
    else:
        private_key = ec.generate_private_key(ec.SECP256R1())
        private_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        PRIVATE_KEY_FILE.write_bytes(private_pem)
        try:
            PRIVATE_KEY_FILE.chmod(0o600)
        except OSError:
            pass

    public_key = public_key_b64url(private_key)
    update_env(
        ENV_FILE,
        {
            **ENV_VALUES,
            "VAPID_PUBLIC_KEY": public_key,
            "VAPID_SUBJECT": subject,
        },
    )
    print("VAPID keys are ready.")
    print("Updated backend/.env without printing its secrets.")
    print("Private key saved to backend/vapid_private.pem; never commit or share it.")
    print("Restart FastAPI after this script finishes.")


if __name__ == "__main__":
    main()
