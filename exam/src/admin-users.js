import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
export const ADMIN_ROLES = Object.freeze(["owner", "admin", "examiner", "finance"]);
const ROLES = new Set(ADMIN_ROLES);

export const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze(["dashboard", "payments", "results", "settings", "questions", "answer_codes", "users"]),
  admin: Object.freeze(["dashboard", "payments", "results", "settings", "questions", "answer_codes"]),
  examiner: Object.freeze(["dashboard", "results"]),
  finance: Object.freeze(["dashboard", "payments"]),
});

export function hasAdminPermission(user, permission) {
  return Boolean(user?.active && ROLE_PERMISSIONS[user.role]?.includes(permission));
}

export class AdminUserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AdminUserError";
    this.status = status;
  }
}

function clean(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeUsername(value) {
  return clean(value, 32).toLowerCase();
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(username)) throw new AdminUserError("用户名须为 3-32 位字母、数字、点、下划线或短横线");
  return username;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 10 || password.length > 128) throw new AdminUserError("密码长度须为 10-128 位");
  return password;
}

function passwordRecord(password, validate = true) {
  const value = validate ? validatePassword(password) : String(password || "");
  if (!value) throw new AdminUserError("初始管理员密码不能为空");
  const salt = crypto.randomBytes(16).toString("base64url");
  const passwordHash = crypto.scryptSync(value, salt, 64).toString("base64url");
  return { passwordSalt: salt, passwordHash };
}

function passwordMatches(password, user) {
  try {
    const expected = Buffer.from(user.passwordHash, "base64url");
    const supplied = crypto.scryptSync(String(password || ""), user.passwordSalt, expected.length);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: ROLE_PERMISSIONS[user.role] || [],
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

export class AdminUserStore {
  constructor({ filePath, seedUsername = "admin", seedPassword, now = () => new Date().toISOString() }) {
    this.filePath = filePath;
    this.now = now;
    this.users = this.read();
    if (!this.users.length) {
      const timestamp = this.now();
      this.users.push({
        id: `adm_${crypto.randomBytes(12).toString("base64url")}`,
        username: validateUsername(seedUsername),
        displayName: "系统所有者",
        role: "owner",
        active: true,
        ...passwordRecord(seedPassword, false),
        createdAt: timestamp,
        updatedAt: timestamp,
        lastLoginAt: null,
      });
      this.save();
    }
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!Array.isArray(value)) throw new Error("管理员账号文件格式错误");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.users, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows does not apply POSIX modes. */ }
  }

  list() {
    return this.users.map(publicUser).sort((left, right) => {
      if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
      return left.username.localeCompare(right.username, "zh-CN");
    });
  }

  getById(id) {
    const user = this.users.find((item) => item.id === id);
    return user ? publicUser(user) : null;
  }

  authenticate(username, password) {
    const normalized = normalizeUsername(username);
    const user = this.users.find((item) => item.username === normalized && item.active);
    if (!user || !passwordMatches(password, user)) return null;
    user.lastLoginAt = this.now();
    user.updatedAt = user.updatedAt || user.lastLoginAt;
    this.save();
    return publicUser(user);
  }

  requireOwner(actorId) {
    const actor = this.users.find((item) => item.id === actorId && item.active);
    if (!actor) throw new AdminUserError("当前管理员账号不存在或已停用", 401);
    if (actor.role !== "owner") throw new AdminUserError("仅所有者可以管理管理员账号", 403);
    return actor;
  }

  create(input, actorId) {
    this.requireOwner(actorId);
    const username = validateUsername(input.username);
    if (this.users.some((item) => item.username === username)) throw new AdminUserError("用户名已存在");
    const displayName = clean(input.displayName, 40);
    if (displayName.length < 2) throw new AdminUserError("显示名称至少需要 2 个字符");
    const role = clean(input.role || "admin", 10);
    if (!ROLES.has(role)) throw new AdminUserError("管理员角色无效");
    const timestamp = this.now();
    const user = {
      id: `adm_${crypto.randomBytes(12).toString("base64url")}`,
      username,
      displayName,
      role,
      active: true,
      ...passwordRecord(input.password),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: null,
    };
    this.users.push(user);
    this.save();
    return publicUser(user);
  }

  update(id, input, actorId) {
    this.requireOwner(actorId);
    const user = this.users.find((item) => item.id === id);
    if (!user) throw new AdminUserError("管理员账号不存在", 404);
    if (input.active === false && user.id === actorId) throw new AdminUserError("不能停用当前账号");

    const nextRole = input.role === undefined ? user.role : clean(input.role, 10);
    const nextActive = input.active === undefined ? user.active : Boolean(input.active);
    if (!ROLES.has(nextRole)) throw new AdminUserError("管理员角色无效");
    if (user.role === "owner" && user.active && (nextRole !== "owner" || !nextActive)) {
      const otherOwners = this.users.filter((item) => item.id !== user.id && item.role === "owner" && item.active);
      if (!otherOwners.length) throw new AdminUserError("必须至少保留一个启用中的所有者");
    }

    if (input.displayName !== undefined) {
      const displayName = clean(input.displayName, 40);
      if (displayName.length < 2) throw new AdminUserError("显示名称至少需要 2 个字符");
      user.displayName = displayName;
    }
    user.role = nextRole;
    user.active = nextActive;
    if (input.password) Object.assign(user, passwordRecord(input.password));
    user.updatedAt = this.now();
    this.save();
    return publicUser(user);
  }

  changePassword(id, currentPassword, newPassword) {
    const user = this.users.find((item) => item.id === id && item.active);
    if (!user || !passwordMatches(currentPassword, user)) throw new AdminUserError("当前密码错误");
    Object.assign(user, passwordRecord(newPassword));
    user.updatedAt = this.now();
    this.save();
    return publicUser(user);
  }

  remove(id, actorId) {
    this.requireOwner(actorId);
    if (id === actorId) throw new AdminUserError("不能删除当前账号");
    const user = this.users.find((item) => item.id === id);
    if (!user) throw new AdminUserError("管理员账号不存在", 404);
    if (user.role === "owner" && user.active) {
      const otherOwners = this.users.filter((item) => item.id !== user.id && item.role === "owner" && item.active);
      if (!otherOwners.length) throw new AdminUserError("必须至少保留一个启用中的所有者");
    }
    this.users = this.users.filter((item) => item.id !== id);
    this.save();
    return publicUser(user);
  }
}
