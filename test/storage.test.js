/**
 * 存储层测试：模板 / 简历 / 数据三层关系。
 *
 * 这里用一个内存版 chrome.storage.local 替身，能真正存取，
 * 所以可以验证「切简历 → 读到另一份数据」「老数据迁移」这类跨调用的行为。
 *
 * 运行：node test/storage.test.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ─────────── 内存版 chrome.storage ───────────
const store = Object.create(null);

globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        if (typeof keys === 'string') {
          if (keys in store) out[keys] = store[keys];
        } else if (Array.isArray(keys)) {
          for (const k of keys) if (k in store) out[k] = store[k];
        } else if (keys && typeof keys === 'object') {
          for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
        }
        cb(out);
      },
      set(obj, cb) {
        Object.assign(store, obj);
        if (cb) cb();
      },
      remove(key, cb) {
        if (Array.isArray(key)) for (const k of key) delete store[k];
        else delete store[key];
        if (cb) cb();
      },
    },
  },
};

globalThis.document = {
  documentElement: { setAttribute() {}, removeAttribute() {} },
  querySelectorAll: () => [],
};

for (const f of [
  'src/shared/00-ns.js',
  'src/shared/normalize.js',
  'src/shared/fields.js',
  'src/shared/storage.js',
]) {
  const file = path.join(ROOT, f);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

let S = globalThis.RA.storage;

/** 迁移只跑一次，测迁移相关的用例前重新加载模块，把那个一次性开关重置掉 */
function reloadStorage() {
  const file = path.join(ROOT, 'src/shared/storage.js');
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  S = globalThis.RA.storage;
  return S;
}

// ─────────── 测试框架（支持 async） ───────────

const checks = [];

function check(name, fn) {
  checks.push([name, fn]);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function clearStore() {
  for (const k of Object.keys(store)) delete store[k];
}

// ─────────── 默认值 ───────────

check('内置模板只有一份，叫「通用模板」且字段齐全', async () => {
  clearStore();
  const t = await S.getTemplates();
  const def = t.list.find((x) => x.id === S.DEFAULT_TEMPLATE_ID);

  assert(def, '缺少内置模板');
  assert(def.name === '通用模板', '名字不对：' + def.name);
  assert(def.groups.length > 0, '内置模板应该有分组');
  assert(def.groups.some((g) => g.fields.length > 0), '内置模板应该有字段');
});

check('老版本保存的内置模板会自动补齐新增字段', async () => {
  clearStore();

  // 模拟上一个版本保存的模板：还没有「学院」「导师」这两个字段
  const oldTpl = S.buildDefaultTemplate();
  const edu = oldTpl.groups.find((g) => g.sectionKey === 'education');
  edu.fields = edu.fields.filter(
    (f) => f.key !== 'educations.college' && f.key !== 'educations.mentor'
  );

  // 用户自建模板不应该被擅自改动
  const custom = {
    id: 'tpl_custom',
    name: '自定义模板',
    groups: [{ sectionKey: 'education', title: '教育经历', fields: [{ key: 'educations.school' }] }],
  };

  await S.setTemplates({ list: [oldTpl, custom] });

  const got = await S.getTemplates();
  const def = got.list.find((t) => t.id === S.DEFAULT_TEMPLATE_ID);
  const keys = def.groups.find((g) => g.sectionKey === 'education').fields.map((f) => f.key);

  assert(keys.includes('educations.college'), '「学院」没有补进内置模板');
  assert(keys.includes('educations.mentor'), '「导师」没有补进内置模板');
  assert(new Set(keys).size === keys.length, '补齐后出现了重复字段');

  const c = got.list.find((t) => t.id === 'tpl_custom');
  assert(c.groups[0].fields.length === 1, '自建模板不该被自动改结构');
});

check('默认有一份「通用简历」，使用内置模板', async () => {
  clearStore();
  const r = await S.getResumes();

  assert(r.list.length === 1, '默认应该只有一份简历');
  assert(r.activeId === S.DEFAULT_RESUME_ID, 'activeId 不对');
  assert(r.list[0].name === '通用简历', '名字不对：' + r.list[0].name);
  assert(r.list[0].templateId === S.DEFAULT_TEMPLATE_ID, '模板绑定不对');
});

// ─────────── 数据读写 ───────────

check('setProfile / getProfile 走当前简历', async () => {
  clearStore();
  await S.setProfile({ basic: { name: '张三' } });
  const p = await S.getProfile();
  assert(p && p.basic.name === '张三');
});

check('新建简历必须绑定模板，并自动成为当前简历', async () => {
  clearStore();
  const r = await S.createResume('技术岗', S.DEFAULT_TEMPLATE_ID);
  const state = await S.getResumes();

  assert(state.activeId === r.id, '新简历应该成为当前简历');
  assert(r.templateId === S.DEFAULT_TEMPLATE_ID, '模板没绑上');
  assert((await S.getProfile()) === null, '新简历的数据应该是空的');
});

check('切换简历读到各自的数据', async () => {
  clearStore();
  await S.setProfile({ basic: { name: '通用版' } });

  const tech = await S.createResume('技术岗', S.DEFAULT_TEMPLATE_ID);
  await S.setProfile({ basic: { name: '技术版' } });

  assert((await S.getProfile()).basic.name === '技术版');

  await S.setActiveResume(S.DEFAULT_RESUME_ID);
  assert((await S.getProfile()).basic.name === '通用版');

  await S.setActiveResume(tech.id);
  assert((await S.getProfile()).basic.name === '技术版');
});

check('删除简历会连带删掉数据，并切到另一份', async () => {
  clearStore();
  const r = await S.createResume('临时', S.DEFAULT_TEMPLATE_ID);
  await S.setProfile({ basic: { name: '临时数据' } });

  const res = await S.deleteResume(r.id);
  assert(res.ok, '删除应该成功');

  const state = await S.getResumes();
  assert(state.activeId === S.DEFAULT_RESUME_ID, '应该切回另一份');
  assert((await S.getProfileFor(r.id)) === null, '数据应该没了');
});

check('最后一份简历不能删', async () => {
  clearStore();
  const res = await S.deleteResume(S.DEFAULT_RESUME_ID);
  assert(!res.ok, '不该允许删');
  assert(res.reason === 'last', '原因应该是 last');
});

// ─────────── 模板与简历的关系 ───────────

check('resumesUsingTemplate 能列出引用者', async () => {
  clearStore();
  await S.setTemplates({
    list: [S.buildDefaultTemplate(), { id: 'tpl_x', name: 'X', groups: [] }],
  });

  await S.createResume('用 X 的', 'tpl_x');
  const users = await S.resumesUsingTemplate('tpl_x');

  assert(users.length === 1, '应该只有一份简历在用');
  assert(users[0].name === '用 X 的');
});

check('内置模板永远在列表里，删不掉', async () => {
  clearStore();
  await S.setTemplates({ list: [{ id: 'tpl_x', name: 'X', groups: [] }] });

  const t = await S.getTemplates();
  assert(t.list.some((x) => x.id === S.DEFAULT_TEMPLATE_ID), '内置模板被弄丢了');
});

check('getActiveTemplate 返回当前简历使用的模板', async () => {
  clearStore();
  await S.setTemplates({
    list: [
      S.buildDefaultTemplate(),
      { id: 'tpl_x', name: 'X', groups: [{ sectionKey: 'basic', title: '基本', fields: [] }] },
    ],
  });

  await S.createResume('用 X', 'tpl_x');
  const tpl = await S.getActiveTemplate();
  assert(tpl.id === 'tpl_x', '拿到的模板不对：' + tpl.id);
});

// ─────────── 整包备份 ───────────

check('整包导出 / 导入能还原模板、简历和数据', async () => {
  clearStore();
  await S.setTemplates({
    list: [S.buildDefaultTemplate(), { id: 'tpl_x', name: 'X', groups: [] }],
  });

  const tech = await S.createResume('技术岗', 'tpl_x');
  await S.setProfile({ basic: { name: '技术数据' } });

  await S.setActiveResume(S.DEFAULT_RESUME_ID);
  await S.setProfile({ basic: { name: '通用数据' } });

  const backup = await S.exportAll();
  assert(backup._type === 'resume-assistant-backup', '类型标记不对');
  assert(backup.resumes.list.length === 2, '备份里的简历数不对');
  assert(backup.profiles[S.DEFAULT_RESUME_ID].basic.name === '通用数据', '数据没打进包里');

  clearStore();
  const res = await S.importAll(backup);
  assert(res.ok, res.reason);

  const state = await S.getResumes();
  assert(state.list.length === 2, '恢复后的简历数不对');
  assert((await S.getProfile()).basic.name === '通用数据', '当前简历的数据没恢复');

  await S.setActiveResume(tech.id);
  assert((await S.getProfile()).basic.name === '技术数据', '第二份简历的数据没恢复');

  const tpls = await S.getTemplates();
  assert(tpls.list.some((t) => t.id === 'tpl_x'), '模板没恢复');
});

check('导入格式不对的备份会被拒绝', async () => {
  const r1 = await S.importAll(null);
  assert(!r1.ok, 'null 不该通过');

  const r2 = await S.importAll({ foo: 1 });
  assert(!r2.ok, '没有 _type 不该通过');

  const r3 = await S.importAll({ _type: 'resume-assistant-backup' });
  assert(!r3.ok, '没有模板和简历不该通过');
});

// ─────────── 迁移 ───────────

check('老结构迁移：拆成模板 + 简历，数据跟着简历走', async () => {
  clearStore();
  store['ra:templates'] = {
    activeId: 'tpl_default',
    list: [
      { id: 'tpl_default', name: '标准简历', groups: [] },
      { id: 'tpl_2', name: '技术岗', groups: [] },
    ],
  };
  store['ra:profiles'] = {
    tpl_default: { basic: { name: '默认数据' } },
    tpl_2: { basic: { name: '技术数据' } },
  };

  const local = reloadStorage();

  const state = await local.getResumes();
  assert(state.list.length === 2, '应该拆出两份简历');
  assert(state.activeId === 'res_tpl_default', '当前简历没跟着迁移');

  assert((await local.getProfile()).basic.name === '默认数据');

  await local.setActiveResume('res_tpl_2');
  assert((await local.getProfile()).basic.name === '技术数据');

  const tpls = await local.getTemplates();
  assert(tpls.list.some((t) => t.id === 'tpl_2'), '模板没迁过来');
  assert(tpls.list.find((t) => t.id === 'tpl_default').name === '标准简历', '模板名没保留');
});

check('上一版结构迁移：数据以模板 id 为键时也能认出来', async () => {
  clearStore();
  store['ra:templates'] = {
    list: [
      { id: 'tpl_default', name: '通用简历', groups: [] },
      { id: 'tpl_2', name: '技术岗', groups: [] },
    ],
  };
  store['ra:profiles'] = {
    tpl_default: { basic: { name: '旧默认' } },
    tpl_2: { basic: { name: '旧技术' } },
  };

  const local = reloadStorage();

  const state = await local.getResumes();
  assert(state.list.length === 2, '应该拆出两份简历');
  assert((await local.getProfile()).basic.name === '旧默认', '当前简历没拿到旧数据');

  await local.setActiveResume('res_tpl_2');
  assert((await local.getProfile()).basic.name === '旧技术', '第二份简历没拿到旧数据');
});

check('更老的单份 ra:profile 也能迁移', async () => {
  clearStore();
  store['ra:templates'] = {
    activeId: 'tpl_default',
    list: [{ id: 'tpl_default', name: '标准', groups: [] }],
  };
  store['ra:profile'] = { basic: { name: '远古数据' } };

  const local = reloadStorage();

  const p = await local.getProfile();
  assert(p && p.basic.name === '远古数据');
  assert(!('ra:profile' in store), '迁移后应该清掉老键');
});

// ─────────── 执行 ───────────

(async () => {
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const [name, fn] of checks) {
    try {
      await fn();
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + name);
    } catch (e) {
      failed++;
      failures.push({ name, message: e.message });
      console.log('  \x1b[31m✗\x1b[0m ' + name);
      console.log('      ' + e.message);
    }
  }

  console.log('\n' + '─'.repeat(52));
  if (failed) {
    console.log(`\x1b[31m${failed} 项失败\x1b[0m，${passed} 项通过`);
    for (const f of failures) console.log(`  · ${f.name}: ${f.message}`);
    process.exit(1);
  } else {
    console.log(`\x1b[32m全部通过\x1b[0m  ${passed} 项`);
  }
})();
