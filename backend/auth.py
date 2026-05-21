from __future__ import annotations
import json
import os
import hashlib
import hmac
import secrets
import re
from datetime import datetime
from typing import Optional

USERS_FILE = os.path.join(os.path.dirname(__file__), 'data', 'users.json')


def _hash_password(password: str, salt: str = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000)
    return key.hex(), salt


def _load_users() -> dict:
    if not os.path.exists(USERS_FILE):
        return {}
    with open(USERS_FILE, encoding='utf-8') as f:
        return json.load(f)


def _save_users(users: dict):
    os.makedirs(os.path.dirname(USERS_FILE), exist_ok=True)
    with open(USERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(users, f, ensure_ascii=False, indent=2)


def ensure_default_admin():
    users = _load_users()
    if 'admin' not in users:
        hashed, salt = _hash_password('admin123')
        users['admin'] = {
            'username': 'admin',
            'password_hash': hashed,
            'salt': salt,
            'role': 'admin',
            'created_at': datetime.now().isoformat(),
        }
        _save_users(users)


def login(username: str, password: str) -> dict | None:
    users = _load_users()
    user = users.get(username)
    if not user:
        return None
    hashed, _ = _hash_password(password, user['salt'])
    if not hmac.compare_digest(hashed, user['password_hash']):
        return None
    return {'username': user['username'], 'role': user['role']}


def get_all_users() -> list:
    users = _load_users()
    return [{'username': u['username'], 'role': u['role'], 'created_at': u.get('created_at', '')}
            for u in users.values()]


def create_user(username: str, password: str, role: str = 'user') -> tuple[bool, str]:
    if not re.match(r'^[a-zA-Z][a-zA-Z0-9_]{1,19}$', username):
        return False, '用户名只能包含字母、数字和下划线，以字母开头，2-20个字符'
    if not validate_password_strength(password):
        return False, '密码至少6位，且同时包含字母和数字'
    users = _load_users()
    if username in users:
        return False, '用户名已存在'
    hashed, salt = _hash_password(password)
    users[username] = {
        'username': username,
        'password_hash': hashed,
        'salt': salt,
        'role': role,
        'created_at': datetime.now().isoformat(),
    }
    _save_users(users)
    return True, '创建成功'


def delete_user(username: str) -> tuple[bool, str]:
    if username == 'admin':
        return False, '不能删除管理员账号'
    users = _load_users()
    if username not in users:
        return False, '用户不存在'
    del users[username]
    _save_users(users)
    return True, '删除成功'


def change_password(username: str, old_password: str, new_password: str) -> tuple[bool, str]:
    if not validate_password_strength(new_password):
        return False, '新密码至少6位，且同时包含字母和数字'
    users = _load_users()
    user = users.get(username)
    if not user:
        return False, '用户不存在'
    hashed_old, _ = _hash_password(old_password, user['salt'])
    if not hmac.compare_digest(hashed_old, user['password_hash']):
        return False, '旧密码错误'
    hashed_new, new_salt = _hash_password(new_password)
    if hmac.compare_digest(hashed_new, user['password_hash']):
        return False, '新密码不能与旧密码相同'
    users[username]['password_hash'] = hashed_new
    users[username]['salt'] = new_salt
    _save_users(users)
    return True, '密码修改成功'


def validate_password_strength(password: str) -> bool:
    if len(password) < 6:
        return False
    has_letter = bool(re.search(r'[a-zA-Z]', password))
    has_digit = bool(re.search(r'\d', password))
    return has_letter and has_digit
