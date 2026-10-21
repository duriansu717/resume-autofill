/**
 * 导入模块的单元测试。
 *
 * 覆盖的是「AI 输出不守规矩」的那些情况：代码围栏、前后废话、
 * 中文引号、尾逗号、裸键、数字、单个对象、中文 key、各种日期写法。
 *
 * 运行：node test/import.test.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of [
  'src/shared/00-ns.js',
  'src/shared/normalize.js',
  'src/shared/fields.js',
  'src/shared/importer.js',
]) {
  const file = path.join(ROOT, f);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

const RA = globalThis.RA;
const I = RA.importer;

// ─────────────────────── 测试框架 ───────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('      ' + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

// ─────────────────────── extractJson ───────────────────────

console.log('\n\x1b[1mextractJson\x1b[0m');

check('纯 JSON 直接解析', () => {
  const r = I.extractJson('{"a":1}');
  assert(r.ok, r.error);
  assert(r.value.a === 1);
});

check('剥掉 ```json 围栏和前后说明', () => {
  const text = '好的，这是结果：\n```json\n{"basic":{"name":"张三"}}\n```\n还需要调整吗？';
  const r = I.extractJson(text);
  assert(r.ok, r.error);
  assert(r.value.basic.name === '张三');
});

check('字符串里的括号不会破坏配对', () => {
  const r = I.extractJson('{"note":"a { b } c"}');
  assert(r.ok, r.error);
  assert(r.value.note === 'a { b } c');
});

check('尾逗号和中文引号能修好', () => {
  const r = I.extractJson('{“name”:“张三”,}');
  assert(r.ok, r.error);
  assert(r.value.name === '张三');
});

check('没加引号的键能修好', () => {
  const r = I.extractJson('{name:"张三"}');
  assert(r.ok, r.error);
  assert(r.value.name === '张三');
});

check('没有 JSON 时给出可读的报错', () => {
  const r = I.extractJson('抱歉，我无法处理这份简历。');
  assert(!r.ok);
  assert(/没找到/.test(r.error));
});

check('括号没闭合时给出可读的报错', () => {
  const r = I.extractJson('{"a":1');
  assert(!r.ok);
  assert(/没有闭合/.test(r.error));
});

// ─────────────────────── normalizeProfile ───────────────────────

console.log('\n\x1b[1mnormalizeProfile\x1b[0m');

check('数字转字符串、单个对象包成数组', () => {
  const r = I.normalizeProfile({
    basic: { name: '张三', phone: 13800138000 },
    educations: { school: '浙江大学' },
  });
  assert(r.profile.basic.phone === '13800138000', '电话没转成字符串');
  assert(Array.isArray(r.profile.educations), 'educations 没包成数组');
  assert(r.profile.educations[0].school === '浙江大学');
  assert(r.fixes.length >= 1, '应该报告修正');
});

check('日期归一化', () => {
  const r = I.normalizeProfile({
    educations: [{ school: 'A', startDate: '2021年7月', endDate: '2021/07/05' }],
  });
  assert(r.profile.educations[0].startDate === '2021-07', r.profile.educations[0].startDate);
  assert(r.profile.educations[0].endDate === '2021-07-05', r.profile.educations[0].endDate);
});

check('数字形式的日期也能归一化', () => {
  const r = I.normalizeProfile({ works: [{ company: 'X', startDate: 202107 }] });
  assert(r.profile.works[0].startDate === '2021-07', String(r.profile.works[0].startDate));
});

check('「至今」留空而不是当成日期', () => {
  const r = I.normalizeProfile({ works: [{ company: 'X', endDate: '至今' }] });
  assert(r.profile.works[0].endDate === undefined);
});

check('扁平中文 key 能映射到字段', () => {
  const r = I.normalizeProfile({ 姓名: '张三', 手机号: '13800138000', 邮箱: 'a@b.com' });
  assert(r.profile.basic.name === '张三');
  assert(r.profile.basic.phone === '13800138000');
  assert(r.profile.basic.email === 'a@b.com');
  assert(r.mapped === 3, 'mapped 应该是 3，实际 ' + r.mapped);
});

check('不认识的键进 unknown，不污染数据', () => {
  const r = I.normalizeProfile({ basic: { name: '张三', 备注: 'x' }, 奇怪的字段: 1 });
  assert(r.profile.basic.name === '张三');
  assert(r.unknown.includes('basic.备注'), r.unknown.join(','));
  assert(r.unknown.includes('奇怪的字段'), r.unknown.join(','));
});

check('空值 / 占位符被清掉', () => {
  const r = I.normalizeProfile({ basic: { name: '张三', phone: 'N/A', email: null } });
  assert(r.profile.basic.name === '张三');
  assert(r.profile.basic.phone === undefined);
  assert(r.profile.basic.email === undefined);
});

check('布尔值转成是 / 否', () => {
  const r = I.normalizeProfile({ works: [{ company: 'X', stillEmployed: true }] });
  assert(r.profile.works[0].stillEmployed === '是');
});

check('数组值合并成一段文本', () => {
  const r = I.normalizeProfile({ projects: [{ name: 'P', tech: ['Java', 'MySQL'] }] });
  assert(r.profile.projects[0].tech === 'Java、MySQL', r.profile.projects[0].tech);
});

check('顶层不是对象时返回错误', () => {
  const r = I.normalizeProfile([1, 2]);
  assert(!!r.error);
});

// ─────────────────────── buildPrompt ───────────────────────

console.log('\n\x1b[1mbuildPrompt\x1b[0m');

check('只包含模板里的字段', () => {
  const tpl = {
    groups: [
      { sectionKey: 'basic', title: '基本信息', fields: [{ key: 'basic.name' }, { key: 'basic.phone' }] },
      { sectionKey: null, title: '自定义', fields: [{ key: 'custom.cf_1', label: '作品集链接' }] },
    ],
  };
  const p = I.buildPrompt(tpl);
  assert(p.includes('"name": ""'), '缺少 name');
  assert(p.includes('"phone": ""'), '缺少 phone');
  assert(p.includes('作品集链接'), '缺少自定义字段');
  assert(!p.includes('"school"'), '不该出现模板外的字段');
});

check('提示词包含关键约束', () => {
  const p = I.buildPrompt(null);
  assert(p.includes('只输出一个 JSON 对象'));
  assert(p.includes('不要编造'));
  assert(p.includes('YYYY-MM'));
});

check('模板为空时回退到全部字段', () => {
  const p = I.buildPrompt(null);
  assert(p.includes('"school"'));
  assert(p.includes('"idCard"'));
});

check('经历类字段生成数组结构', () => {
  const p = I.buildPrompt({
    groups: [
      { sectionKey: 'education', title: '教育', fields: [{ key: 'educations.school' }] },
    ],
  });
  assert(p.includes('"educations": ['), p.slice(0, 400));
});

// ─────────────────────── countValues ───────────────────────

console.log('\n\x1b[1mcountValues\x1b[0m');

check('统计非空字符串', () => {
  const n = I.countValues({
    basic: { name: '张三', phone: '' },
    educations: [{ school: 'A', major: '' }],
  });
  assert(n === 2, '期望 2，实际 ' + n);
});

// ─────────────────────── 汇总 ───────────────────────

console.log('\n' + '─'.repeat(52));
if (failed) {
  console.log(`\x1b[31m${failed} 项失败\x1b[0m，${passed} 项通过`);
  for (const f of failures) console.log(`  · ${f.name}: ${f.message}`);
  process.exit(1);
} else {
  console.log(`\x1b[32m全部通过\x1b[0m  ${passed} 项`);
}
