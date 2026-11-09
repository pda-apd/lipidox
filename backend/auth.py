from __future__ import annotations

import contextvars
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt as _bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jwt import PyJWTError as JWTError
from sqlalchemy.orm import Session

from config import get_settings
from db import get_db_dep
from models import User

# Per-request user id used to tag log records so the /log-stream SSE endpoint
# can filter logs per account. asyncio.run_in_executor copies the current
# context to worker threads, so background analysis tasks inherit this value.
log_uid_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "log_uid", default=None
)

settings = get_settings()

# bcrypt has a 72-byte password limit; truncate to stay compatible with
# legacy behavior (older bcrypt silently truncated).
_BCRYPT_MAX_BYTES = 72

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

_token_blacklist: set[str] = set()


def hash_password(password: str) -> str:
    pw = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    return _bcrypt.hashpw(pw, _bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        pw = plain.encode("utf-8")[:_BCRYPT_MAX_BYTES]
        return _bcrypt.checkpw(pw, hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: uuid.UUID, email: str) -> str:
    now = datetime.now(timezone.utc)
    expire = now + timedelta(hours=settings.jwt_expire_hours)
    payload = {
        "sub": str(user_id),
        "email": email,
        "jti": uuid.uuid4().hex,
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "exp": expire,
        "iat": now,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
        )
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    if token in _token_blacklist:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")
    return payload


def token_is_revoked(db: Session, payload: dict) -> bool:
    from models import RevokedToken

    jti = payload.get("jti")
    if not jti:
        return False
    return db.query(RevokedToken.jti).filter(RevokedToken.jti == str(jti)).first() is not None


def revoke_token(db: Session, payload: dict) -> None:
    from models import RevokedToken

    jti = payload.get("jti")
    if not jti:
        return
    exp = payload.get("exp")
    expires_at = (
        datetime.fromtimestamp(int(exp), tz=timezone.utc)
        if exp else datetime.now(timezone.utc) + timedelta(hours=settings.jwt_expire_hours)
    )
    if not db.query(RevokedToken.jti).filter(RevokedToken.jti == str(jti)).first():
        db.add(RevokedToken(jti=str(jti), expires_at=expires_at))
        db.commit()
    db.query(RevokedToken).filter(RevokedToken.expires_at < datetime.now(timezone.utc)).delete()


def purge_expired_revocations(db: Session) -> None:
    from models import RevokedToken

    db.query(RevokedToken).filter(
        RevokedToken.expires_at < datetime.now(timezone.utc)
    ).delete()
    db.commit()


SESSION_COOKIE = "lipidportal_session"


async def get_current_user(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db_dep),
) -> User:
    # HttpOnly cookie is the primary transport; Bearer stays for API clients.
    if not token:
        token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = decode_token(token)
    if token_is_revoked(db, payload):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
    try:
        uid = uuid.UUID(str(user_id))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
    user = db.query(User).filter(User.id == uid).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    log_uid_var.set(str(user.id))
    return user


async def get_current_user_optional(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db_dep),
) -> Optional[User]:
    if not token and not request.cookies.get(SESSION_COOKIE):
        return None
    try:
        return await get_current_user(request, token, db)
    except HTTPException:
        return None
