import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { AdminUserStore, hasAdminPermission } from "../src/admin-users.js";

let directory;
let store;

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jqdj-admin-users-"));
  store = new AdminUserStore({
    filePath: path.join(directory, "admin-users.json"),
    seedUsername: "admin",
    seedPassword: "Initial_Admin_2026",
  });
});

after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("legacy admin password seeds an owner account with a hash", () => {
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, "admin-users.json"), "utf8"));
  assert.equal(persisted[0].username, "admin");
  assert.equal(persisted[0].role, "owner");
  assert.equal("password" in persisted[0], false);
  assert.notEqual(persisted[0].passwordHash, "Initial_Admin_2026");
  assert.equal(store.authenticate("admin", "Initial_Admin_2026").username, "admin");
});

test("owner can create an administrator with independent credentials", () => {
  const owner = store.authenticate("admin", "Initial_Admin_2026");
  const created = store.create({
    username: "reviewer",
    displayName: "成绩复核员",
    password: "Reviewer_2026_Pass",
    role: "admin",
  }, owner.id);

  assert.equal(created.role, "admin");
  assert.equal(store.authenticate("reviewer", "Reviewer_2026_Pass").displayName, "成绩复核员");
  assert.equal(store.authenticate("reviewer", "Initial_Admin_2026"), null);
});

test("usernames are unique and password resets invalidate the old password", () => {
  const owner = store.authenticate("admin", "Initial_Admin_2026");
  assert.throws(() => store.create({
    username: "Reviewer",
    displayName: "重复账号",
    password: "Another_2026_Pass",
    role: "admin",
  }, owner.id), /用户名已存在/);

  const reviewer = store.list().find((user) => user.username === "reviewer");
  store.update(reviewer.id, { password: "Reviewer_New_2026", active: true }, owner.id);
  assert.equal(store.authenticate("reviewer", "Reviewer_2026_Pass"), null);
  assert.equal(store.authenticate("reviewer", "Reviewer_New_2026").username, "reviewer");
});

test("an administrator cannot manage accounts and the owner cannot remove itself", () => {
  const owner = store.authenticate("admin", "Initial_Admin_2026");
  const reviewer = store.authenticate("reviewer", "Reviewer_New_2026");

  assert.throws(() => store.create({
    username: "operator",
    displayName: "运营员",
    password: "Operator_2026_Pass",
    role: "admin",
  }, reviewer.id), /仅所有者/);
  assert.throws(() => store.remove(owner.id, owner.id), /不能删除当前账号/);
  assert.throws(() => store.update(owner.id, { active: false }, owner.id), /不能停用当前账号/);
});

test("each active administrator can change its own password", () => {
  const reviewer = store.authenticate("reviewer", "Reviewer_New_2026");
  store.changePassword(reviewer.id, "Reviewer_New_2026", "Reviewer_Self_2026");
  assert.equal(store.authenticate("reviewer", "Reviewer_New_2026"), null);
  assert.equal(store.authenticate("reviewer", "Reviewer_Self_2026").username, "reviewer");
});

test("examiner and finance roles receive separated permissions", () => {
  const owner = store.authenticate("admin", "Initial_Admin_2026");
  const examiner = store.create({ username: "examiner", displayName: "考官", password: "Examiner_2026_Pass", role: "examiner" }, owner.id);
  const finance = store.create({ username: "finance", displayName: "财务", password: "Finance_2026_Pass", role: "finance" }, owner.id);

  assert.equal(hasAdminPermission(examiner, "results"), true);
  assert.equal(hasAdminPermission(examiner, "payments"), false);
  assert.equal(hasAdminPermission(finance, "payments"), true);
  assert.equal(hasAdminPermission(finance, "results"), false);
  assert.equal(hasAdminPermission(finance, "users"), false);
});
