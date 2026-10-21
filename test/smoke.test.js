/**
 * 冒烟测试：把所有模块按 manifest 里的顺序加载一遍，
 * 检查它们能不能正确挂到 RA 命名空间上、导出的函数名有没有拼错。
 *
 * 这类错误（少导出一个函数、名字打错）在浏览器里要等到真正点到那一行才炸，
 * 这里提前抓出来。
 *
 * 运行：node test/smoke.test.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ─────────── 最小桩，让模块级别的代码能跑过 ───────────
const messageListeners = [];
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    getURL: (p) => p,
    openOptionsPage: () => {},
  },
  storage: {
    local: {
      get: (k, cb) => cb({}),
      set: (o, cb) => cb && cb(),
      remove: (k, cb) => cb && cb(),
    },
  },
};
globalThis.document = {
  querySelectorAll: () => [],
  querySelector: () => null,
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }),
  addEventListener: () => {},
  body: null,
  documentElement: null,
};
globalThis.CSS = { escape: (s) => s };
globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });

// ─────────── 最小的 <select> 桩 ───────────
// setNativeValue 靠 instanceof 选原型，所以这三个构造函数必须存在，
// 否则会抛 ReferenceError 而不是走 else 分支。
class FakeOption {
  constructor(value, text, disabled) {
    this.value = value;
    this.textContent = text;
    this.disabled = !!disabled;
    this.label = text;
  }
}

class FakeSelect {
  constructor(options) {
    this.options = options;
    this.selectedIndex = 0;
    this.events = [];
  }
  get value() {
    const o = this.options[this.selectedIndex];
    return o ? o.value : '';
  }
  set value(v) {
    // 真实 <select> 的行为：找不到匹配项时 selectedIndex 变成 -1
    this.selectedIndex = this.options.findIndex((o) => o.value === String(v));
  }
  dispatchEvent(e) {
    this.events.push(e);
    return true;
  }
}

class FakeInput {
  constructor(value) {
    this.value = value == null ? '' : value;
    this._checked = false;
    this.events = [];
  }
  // checked 必须是原型上的访问器——setNativeValue / setNativeChecked
  // 都靠 Object.getOwnPropertyDescriptor(原型, 属性名) 找原生 setter
  get checked() { return this._checked; }
  set checked(v) { this._checked = !!v; }
  dispatchEvent(e) {
    this.events.push(e);
    return true;
  }
}

globalThis.HTMLSelectElement = FakeSelect;
globalThis.HTMLInputElement = FakeInput;
globalThis.HTMLTextAreaElement = class FakeTextArea {};

let passed = 0;
let failed = 0;
const failures = [];

/** 异步用例挂在这里，最后统一等待 */
const pending = [];

function check(name, fn) {
  let result;
  try {
    result = fn();
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('      ' + e.message);
    return;
  }

  // 返回 Promise 的用例（比如 DOCX 解压）
  if (result && typeof result.then === 'function') {
    pending.push(result.then(
      () => {
        passed++;
        console.log('  \x1b[32m✓\x1b[0m ' + name);
      },
      (e) => {
        failed++;
        failures.push({ name, message: e.message });
        console.log('  \x1b[31m✗\x1b[0m ' + name);
        console.log('      ' + e.message);
      }
    ));
    return;
  }

  passed++;
  console.log('  \x1b[32m✓\x1b[0m ' + name);
}

// ─────────── 按 manifest 顺序加载 ───────────
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const contentScripts = manifest.content_scripts[0].js;

console.log('\n\x1b[1m模块加载\x1b[0m');

for (const rel of contentScripts) {
  check('加载 ' + rel, () => {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) throw new Error('文件不存在：' + rel);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  });
}

const RA = globalThis.RA;

// ─────────── 元信息 ───────────

console.log('\n\x1b[1m版本\x1b[0m');

check('manifest 与 RA.version 版本号一致', () => {
  if (manifest.version !== RA.version) {
    throw new Error(`manifest ${manifest.version} ≠ RA.version ${RA.version}`);
  }
});

// ─────────── 导出契约 ───────────
console.log('\n\x1b[1m导出契约\x1b[0m');

const EXPECTED = {
  normalize: ['text', 'spaced', 'matchAlias', 'bestMatch', 'anyMatch', 'dateParts', 'pad2', 'escapeRe', 'toHalfWidth'],
  importer: ['extractJson', 'repair', 'normalizeProfile', 'buildPrompt', 'countValues'],
  fields: ['DEFS', 'BY_KEY', 'SECTION_ALIASES', 'SECTION_ALIASES_EN', 'REPEATING_SECTIONS', 'ARRAY_NAME_BY_SECTION', 'SECTION_LABEL', 'isRepeating', 'sectionOf'],
  storage: ['getProfile', 'setProfile', 'getSettings', 'setSettings', 'validateProfile',
    'deriveFromIdCard', 'deriveAge', 'resolveTheme', 'applyThemeToDocument',
    'buildDefaultTemplate', 'getTemplates', 'setTemplates',
    'TEMPLATE', 'DEFAULT_SETTINGS'],
  scan: ['collectFields', 'collectSignals', 'resolveLabel', 'formItemContainer', 'ownText', 'stripDynamicTokens', 'isValueLikePlaceholder', 'shouldSkip', 'kindOf'],
  section: ['annotate', 'findSectionTitle', 'classifySectionKind', 'findEntryContainer', 'findAddButton', 'detectDateCluster', 'inferUnit', 'looksLikeFieldLabel'],
  score: ['match', 'scoreField', 'signalSources', 'contribution', 'slotOf'],
  fill: ['setNativeValue', 'setNativeChecked', 'triggerBlur', 'selectByText', 'fillChoiceGroup',
    'fillDateCluster', 'customWidget', 'writeOne', 'valueFor', 'valueVariants', 'isDateKey',
    'readBack', 'sameish', 'undoAll', 'undoLast', 'waitFor', 'withTimeout', 'sleep'],
  overlay: ['showPanel', 'teardown', 'markField', 'markUnfilled', 'clearMarks',
    'setHighlight', 'clearHighlight', 'showHintBar', 'showToast', 'applyTheme', 'ensureHost'],
  pick: ['start', 'stop', 'isActive', 'resolveTarget', 'isFromOverlay'],
  datapanel: ['toggle', 'open', 'close', 'isOpen', 'refresh',
    'buildGroups', 'copyToClipboard', 'setTarget', 'clearTarget', 'startPicking', 'getTarget'],
  main: ['freshScan', 'doFill', 'doScanOnly', 'ensureEntries', 'fillField'],
};

for (const [mod, fns] of Object.entries(EXPECTED)) {
  check(`RA.${mod} 导出完整`, () => {
    const o = RA[mod];
    if (!o) throw new Error(`RA.${mod} 不存在`);
    const missing = fns.filter((f) => o[f] === undefined);
    if (missing.length) throw new Error('缺少：' + missing.join(', '));
  });
}

// ─────────── 跨模块引用检查 ───────────
console.log('\n\x1b[1m跨模块引用\x1b[0m');

/**
 * 把源码里所有 RA.x.y 的引用抠出来，逐个确认真的存在。
 * 这类拼写错误在浏览器里要等到那一行被执行才暴露。
 */
function collectRefs(src) {
  const refs = new Set();
  const re = /\bRA\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) refs.add(m[1] + '.' + m[2]);
  return refs;
}

const allFiles = [
  ...contentScripts,
  'src/popup/popup.js',
  'src/options/options.js',
];

const broken = [];
for (const rel of allFiles) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const ref of collectRefs(src)) {
    const [mod, fn] = ref.split('.');
    if (ref === 'fill._undoStack') continue; // 内部调试字段
    if (!RA[mod] || RA[mod][fn] === undefined) {
      broken.push(`${rel} 里引用了不存在的 ${ref}`);
    }
  }
}

check('所有 RA.x.y 引用都能解析', () => {
  if (broken.length) throw new Error('\n      ' + broken.join('\n      '));
});

// ─────────── 词表自洽性 ───────────
console.log('\n\x1b[1m词表自洽性\x1b[0m');

check('DEFS 里没有重复的 key', () => {
  const seen = new Set();
  for (const d of RA.fields.DEFS) {
    if (seen.has(d.key)) throw new Error('重复 key：' + d.key);
    seen.add(d.key);
  }
});

check('每个字段的 key 都能反查到定义', () => {
  for (const d of RA.fields.DEFS) {
    if (RA.fields.BY_KEY[d.key] !== d) throw new Error(d.key + ' 的 BY_KEY 反查不一致');
  }
});

check('每个字段都属于一个已知区块', () => {
  const known = new Set(Object.keys(RA.fields.SECTION_ALIASES));
  for (const d of RA.fields.DEFS) {
    if (!known.has(d.section)) throw new Error(`${d.key} 的区块 "${d.section}" 不在 SECTION_ALIASES 里`);
  }
});

check('每个区块都至少有一个字段', () => {
  for (const sec of Object.keys(RA.fields.SECTION_ALIASES)) {
    const n = RA.fields.DEFS.filter((d) => d.section === sec).length;
    if (!n) throw new Error(`区块 ${sec} 没有任何字段`);
  }
});

check('经历类区块都能映射到简历数组名', () => {
  for (const sec of RA.fields.REPEATING_SECTIONS) {
    if (!RA.fields.ARRAY_NAME_BY_SECTION[sec]) throw new Error(sec + ' 没有对应的数组名');
  }
});

check('同义别名内部无重复', () => {
  for (const d of RA.fields.DEFS) {
    const all = [...(d.aliases || []), ...(d.generic || [])];
    const dup = all.filter((x, i) => all.indexOf(x) !== i);
    if (dup.length) throw new Error(`${d.key} 里有重复别名：${[...new Set(dup)].join(', ')}`);
  }
});

check('JSON 起始模板里的每个字段都有对应的匹配规则', () => {
  // 模板里出现一个词表里没有的字段，用户填了也永远不会被填进表单——
  // 这种「静默无效」最难发现，必须挡住
  const defs = new Set(RA.fields.DEFS.map((d) => d.key));
  const missing = [];
  for (const [sec, val] of Object.entries(RA.storage.TEMPLATE)) {
    if (sec.startsWith('_')) continue;
    const items = Array.isArray(val) ? val : [val];
    for (const item of items) {
      for (const k of Object.keys(item)) {
        if (!defs.has(sec + '.' + k)) missing.push(sec + '.' + k);
      }
    }
  }
  if (missing.length) {
    throw new Error('模板里这些字段没有匹配规则，填不上：\n      ' + missing.join('\n      '));
  }
});

check('模板里的区块都定义了中文显示名', () => {
  const labels = RA.fields.SECTION_LABEL;
  const arrays = RA.fields.ARRAY_NAME_BY_SECTION;
  for (const sec of Object.keys(RA.storage.TEMPLATE)) {
    if (sec.startsWith('_') || sec === 'basic' || sec === 'jobIntention' || sec === 'emergency') continue;
    const sectionKey = Object.keys(arrays).find((k) => arrays[k] === sec);
    if (!sectionKey) throw new Error(`${sec} 没有在 ARRAY_NAME_BY_SECTION 里登记`);
    if (!labels[sectionKey]) throw new Error(`区块 ${sectionKey} 没有中文显示名`);
  }
});

check('同一别名没有跨字段冲突（强别名不得重复）', () => {
  const owner = new Map();
  const conflicts = [];
  for (const d of RA.fields.DEFS) {
    for (const a of d.aliases || []) {
      const n = RA.normalize.text(a);
      if (!n) continue;
      if (owner.has(n) && owner.get(n) !== d.key) {
        conflicts.push(`「${a}」同时属于 ${owner.get(n)} 和 ${d.key}`);
      }
      owner.set(n, d.key);
    }
  }
  if (conflicts.length) throw new Error('\n      ' + conflicts.join('\n      '));
});

// ─────────── 存储校验 ───────────
console.log('\n\x1b[1m存储校验\x1b[0m');

check('模板本身能通过校验', () => {
  const r = RA.storage.validateProfile(RA.storage.TEMPLATE);
  if (!r.ok) throw new Error('模板校验失败：' + JSON.stringify(r.errors));
});

check('空对象能通过校验（全部字段都是可选的）', () => {
  const r = RA.storage.validateProfile({});
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
});

check('非对象被拒绝', () => {
  for (const bad of [null, 42, 'abc', []]) {
    const r = RA.storage.validateProfile(bad);
    if (r.ok) throw new Error('应该拒绝：' + JSON.stringify(bad));
  }
});

check('数组字段写成对象会被拒绝', () => {
  const r = RA.storage.validateProfile({ works: { company: 'x' } });
  if (r.ok) throw new Error('works 写成对象应该报错');
});

check('错误日期格式被识别', () => {
  const r = RA.storage.validateProfile({ educations: [{ startDate: '去年九月' }] });
  if (r.ok) throw new Error('无法识别的日期应该报错');
  if (!r.errors.some((e) => e.path === 'educations[0].startDate')) {
    throw new Error('错误路径不对：' + JSON.stringify(r.errors));
  }
});

check('身份证与生日不一致会被指出', () => {
  const r = RA.storage.validateProfile({
    basic: { idCard: '110101199807151234', birthday: '1990-01-01' },
  });
  if (!r.errors.some((e) => /身份证/.test(e.message))) {
    throw new Error('应该提示生日与身份证不符');
  }
});

check('身份证推导生日与性别', () => {
  const d = RA.storage.deriveFromIdCard('110101199807151234');
  if (!d) throw new Error('应该能推导');
  if (d.birthday !== '1998-07-15') throw new Error('生日推导错误：' + d.birthday);
  if (d.gender !== '男') throw new Error('性别推导错误：' + d.gender);
  // 倒数第二位是顺序码，奇数为男
  const f = RA.storage.deriveFromIdCard('110101199807151244');
  if (f.gender !== '女') throw new Error('偶数顺序码应为女，实际 ' + f.gender);
});

check('年龄推导', () => {
  const age = RA.storage.deriveAge('2000-01-01');
  const expected = new Date().getFullYear() - 2000 - (new Date().getMonth() === 0 && new Date().getDate() < 1 ? 0 : 0);
  if (typeof age !== 'number' || age < 20 || age > 40) throw new Error('年龄不合理：' + age);
  if (RA.storage.deriveAge('不是日期') !== null) throw new Error('非法输入应返回 null');
});

// ─────────── 下拉框填充 ───────────

console.log('\n\x1b[1m下拉框填充\x1b[0m');

function mkSelect(opts) {
  return new FakeSelect(opts.map(([v, t, d]) => new FakeOption(v, t, d)));
}

check('按选项文字选中，并且真的派发了 input / change 事件', () => {
  // 这条出过一次真实故障：selectByText 里先写了 sel.value 再调 setNativeValue，
  // 而 setNativeValue 开头有「值没变就早退」的判断 —— 结果一个事件都不发，
  // React 的 tracker 也不会被推回旧值。界面上看着选中了，提交时是空的。
  const sel = mkSelect([['', '请选择'], ['1', '男'], ['2', '女']]);
  const ok = RA.fill.selectByText(sel, ['男']);

  if (!ok) throw new Error('应该选中成功');
  if (sel.value !== '1') throw new Error(`选中了错误的项：${sel.value}`);

  const types = sel.events.map((e) => e.type);
  if (!types.includes('change')) throw new Error('没有派发 change 事件（框架收不到）');
  if (!types.includes('input')) throw new Error('没有派发 input 事件（React 收不到）');
});

check('不会选中占位项', () => {
  const sel = mkSelect([['', '请选择'], ['1', '男']]);
  // 「请选择」不该被当成「男」的匹配目标
  if (RA.fill.selectByText(sel, ['请选择'])) {
    throw new Error('不该选中占位项');
  }
  if (sel.selectedIndex !== 0) throw new Error('不应该改动选中项');
});

check('「大学本科」能匹配到简历里的「本科」', () => {
  const sel = mkSelect([['', '请选择'], ['1', '大专'], ['2', '大学本科'], ['3', '硕士']]);
  if (!RA.fill.selectByText(sel, RA.fill.valueVariants('educations.degree', '本科'))) {
    throw new Error('应该匹配上');
  }
  if (sel.value !== '2') throw new Error(`选错了：${sel.value}`);
});

check('value="0" 是合法选项，不能被当成占位符', () => {
  // 早先的实现把 value="0" 一律当占位，会误伤「0 年经验」「0 次」这类选项
  const sel = mkSelect([['-1', '请选择'], ['0', '0年'], ['1', '1年']]);
  if (!RA.fill.selectByText(sel, ['0年'])) throw new Error('应该能选中 value=0 的项');
  if (sel.value !== '0') throw new Error(`选错了：${sel.value}`);
});

check('选不中时如实返回 false，且不改动原值', () => {
  const sel = mkSelect([['', '请选择'], ['1', '男'], ['2', '女']]);
  sel.selectedIndex = 1;
  if (RA.fill.selectByText(sel, ['完全不相干的内容'])) throw new Error('不该报告成功');
  if (sel.selectedIndex !== 1) throw new Error('失败时不该改动选中项');
});

check('禁用的选项不会被选中', () => {
  const sel = mkSelect([['', '请选择'], ['1', '男', true], ['2', '男性']]);
  if (!RA.fill.selectByText(sel, ['男'])) throw new Error('应该退而选中可用的项');
  if (sel.value !== '2') throw new Error(`选中了禁用项或选错：${sel.value}`);
});

// ─────────── 单选 / 复选框 ───────────

console.log('\n\x1b[1m单选与复选框\x1b[0m');

check('勾选时改写 checked 并派发事件', () => {
  // 这里曾经和下拉框犯同一个错：单选按钮的「有意义状态」是 checked 而不是 value，
  // 走 setNativeValue 会因为它写的是 value（值没变）而早退，一个事件都发不出来
  const el = new FakeInput('male');
  if (!RA.fill.setNativeChecked(el, true)) throw new Error('应该成功');
  if (el.checked !== true) throw new Error('checked 没被改上');
  const types = el.events.map((e) => e.type);
  if (!types.includes('change')) throw new Error('没有派发 change 事件');
  if (!types.includes('input')) throw new Error('没有派发 input 事件');
});

check('已经是目标状态时不重复派发事件', () => {
  const el = new FakeInput('male');
  el.checked = true;
  el.events.length = 0;
  RA.fill.setNativeChecked(el, true);
  if (el.events.length) throw new Error('状态没变时不该派发事件');
});

check('取消勾选也能生效（撤销时需要）', () => {
  const el = new FakeInput('male');
  el.checked = true;
  el.events.length = 0;
  RA.fill.setNativeChecked(el, false);
  if (el.checked !== false) throw new Error('checked 没被取消');
  if (!el.events.some((e) => e.type === 'change')) {
    throw new Error('取消勾选也要派发事件，否则框架状态和页面对不上');
  }
});

check('React 的 _valueTracker 停在旧值上，这样它才会察觉变化', () => {
  const el = new FakeInput('male');
  el.checked = true;   // 当前选中
  let tracked = 'male';
  el._valueTracker = { getValue: () => tracked, setValue: (v) => { tracked = String(v); } };

  RA.fill.setNativeChecked(el, false); // 取消选中

  // React 对 checkbox/radio 的 tracker 存的是「选中时=value，未选中时=空串」。
  // 改完 DOM 状态之后，tracker 必须仍停在旧状态上——
  // 两者一旦相等，React 就认为「没变化」，onChange 不会触发。
  const domNow = el.checked ? el.value : '';
  if (tracked === domNow) {
    throw new Error('tracker 和 DOM 状态一致了，React 会认为没变化、不触发 onChange');
  }
  if (tracked !== 'male') throw new Error(`tracker 应该停在旧值 "male"，实际 "${tracked}"`);
});

// ─────────── 主题 ───────────

console.log('\n\x1b[1m主题\x1b[0m');

check('默认设置包含主题项，默认跟随系统', () => {
  if (RA.storage.DEFAULT_SETTINGS.theme !== 'auto') {
    throw new Error('默认主题应该是 auto，实际 ' + RA.storage.DEFAULT_SETTINGS.theme);
  }
});

check('明确指定主题时直接采用', () => {
  if (RA.storage.resolveTheme('light') !== 'light') throw new Error('light 解析错了');
  if (RA.storage.resolveTheme('dark') !== 'dark') throw new Error('dark 解析错了');
});

check('跟随系统时读取系统偏好', () => {
  const original = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
    if (RA.storage.resolveTheme('auto') !== 'dark') throw new Error('系统深色时应解析为 dark');

    globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
    if (RA.storage.resolveTheme('auto') !== 'light') throw new Error('系统浅色时应解析为 light');
  } finally {
    if (original === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = original;
  }
});

check('环境不支持 matchMedia 时兜底为浅色，不抛异常', () => {
  const original = globalThis.matchMedia;
  try {
    delete globalThis.matchMedia;
    if (RA.storage.resolveTheme('auto') !== 'light') throw new Error('兜底应该是 light');
    if (RA.storage.resolveTheme(undefined) !== 'light') throw new Error('undefined 应该兜底 light');
    if (RA.storage.resolveTheme('乱七八糟') !== 'light') throw new Error('未知值应该兜底 light');
  } finally {
    if (original !== undefined) globalThis.matchMedia = original;
  }
});

check('配色由 data-theme 驱动，CSS 里不再有 prefers-color-scheme', () => {
  // 如果 CSS 又用回媒体查询，「用户强制浅色」就会被系统深色覆盖，
  // 主题选择器看起来能用、实际不生效——这种问题很难排查，所以钉住。
  const fs = require('fs');
  const path = require('path');
  const files = ['src/popup/popup.css', 'src/options/options.css', 'src/content/50-overlay.js'];

  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/@media[^{]*prefers-color-scheme/.test(src)) {
      throw new Error(rel + ' 里还有 prefers-color-scheme 媒体查询');
    }
  }

  // 三个界面都要有 data-theme 的暗色规则
  const popupCss = fs.readFileSync(path.join(ROOT, 'src/popup/popup.css'), 'utf8');
  const optionsCss = fs.readFileSync(path.join(ROOT, 'src/options/options.css'), 'utf8');
  const overlay = fs.readFileSync(path.join(ROOT, 'src/content/50-overlay.js'), 'utf8');
  if (!popupCss.includes('[data-theme="dark"]')) throw new Error('popup.css 缺少暗色规则');
  if (!optionsCss.includes('[data-theme="dark"]')) throw new Error('options.css 缺少暗色规则');
  if (!overlay.includes('[data-ra-theme="dark"]')) throw new Error('浮层缺少暗色规则');
});

// ─────────── 简历数据面板 ───────────

console.log('\n\x1b[1m简历数据面板\x1b[0m');

check('按模块分层：模块 → 条目 → 字段', () => {
  const groups = RA.datapanel.buildGroups({
    basic: { name: '张三' },
    educations: [{ school: 'A大学' }, { school: 'B大学' }],
  });

  const basic = groups.find((g) => g.key === 'basic');
  const edu = groups.find((g) => g.key === 'education');

  if (!basic || !edu) throw new Error('缺少模块：' + groups.map((g) => g.key).join(', '));
  if (basic.isArray) throw new Error('基本信息不该是数组模块');
  if (!edu.isArray) throw new Error('教育经历应该是数组模块');

  if (edu.entries.length !== 2) throw new Error('两条教育经历应该是两个条目');
  if (edu.entries[0].title !== '教育经历 1') {
    throw new Error('条目标题不对：' + edu.entries[0].title);
  }
  if (basic.entries[0].items[0].key !== 'basic.name') {
    throw new Error('字段没放到正确的层级');
  }
});

check('简单模块不产生条目小标题（只有数组模块才有）', () => {
  const groups = RA.datapanel.buildGroups({ basic: { name: '张三' } });
  const basic = groups.find((g) => g.key === 'basic');
  if (!basic.entries.length) throw new Error('应该有一个条目容器');
  if (basic.entries[0].title !== null) {
    throw new Error('简单模块的条目不该有标题：' + basic.entries[0].title);
  }
});

check('模块统计的是有效字段总数', () => {
  const groups = RA.datapanel.buildGroups({ basic: { name: '张三', phone: '138' } });
  const basic = groups.find((g) => g.key === 'basic');
  if (basic.count !== 2) throw new Error('count 不对：' + basic.count);
});

check('空字段不进面板（否则满屏都是没内容的行）', () => {
  const groups = RA.datapanel.buildGroups({ basic: { name: '张三', email: '' } });
  const basic = groups.find((g) => g.key === 'basic');
  const items = basic.entries[0].items;
  if (items.some((i) => i.key === 'basic.email')) throw new Error('空邮箱不该出现');
  if (!items.some((i) => i.key === 'basic.name')) throw new Error('姓名应该出现');
});

check('没有数据的模块整个不出现', () => {
  const groups = RA.datapanel.buildGroups({ basic: { name: '张三' } });
  if (groups.some((g) => g.key === 'work')) {
    throw new Error('没有工作经历却生成了模块：' + groups.map((g) => g.key).join(', '));
  }
});

check('字段都带 key 和 entryIndex，能直接拿去填', () => {
  const groups = RA.datapanel.buildGroups({
    works: [{ company: 'A公司' }, { company: 'B公司' }],
  });
  const work = groups.find((g) => g.key === 'work');
  const second = work.entries.find((e) => e.index === 1);
  if (!second) throw new Error('第二条工作经历没生成条目');

  const company = second.items.find((i) => i.key === 'works.company');
  if (!company) throw new Error('缺少 works.company');
  if (company.entryIndex !== 1) throw new Error(`entryIndex 错了：${company.entryIndex}`);
});

check('完全空的简历不会崩，返回空列表', () => {
  const groups = RA.datapanel.buildGroups({});
  if (!Array.isArray(groups)) throw new Error('应该返回数组');
  if (groups.length) throw new Error('空简历不该产生模块');
});

// ─── 单行 / 整行排布 ───

check('宽度估算：中文按 1，英文数字按 0.55', () => {
  const w = RA.datapanel._displayWidth;
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  if (w('张三') !== 2) throw new Error('两个汉字应该是 2');
  if (!near(w('12345'), 2.75)) throw new Error('5 个数字应该是 2.75，实际 ' + w('12345'));
  if (w('') !== 0) throw new Error('空串应该是 0');
  if (!near(w('张san'), 1 + 1.65)) throw new Error('中英混合算错了：' + w('张san'));
});

check('短字段两两并排，长字段独占整行', () => {
  const short = { label: '姓名', value: '张三', key: 'basic.name', entryIndex: 0 };
  const mid = { label: '手机号码', value: '13800138000', key: 'basic.phone', entryIndex: 0 };
  const long = {
    label: '主修课程',
    value: '数据结构、操作系统、计算机网络、数据库原理、编译原理',
    key: 'educations.courses', entryIndex: 0,
  };

  if (RA.datapanel._needsFullRow(short)) throw new Error('「姓名」不该独占整行');
  if (RA.datapanel._needsFullRow(mid)) throw new Error('手机号不该独占整行');
  if (!RA.datapanel._needsFullRow(long)) throw new Error('长课程名应该独占整行');
});

check('长标签也独占整行（否则标签会被截断）', () => {
  const it = { label: '紧急联系人电话', value: '138', key: 'emergency.phone', entryIndex: 0 };
  if (!RA.datapanel._needsFullRow(it)) throw new Error('长标签应该独占整行');
});

check('超长英文值独占整行', () => {
  const it = {
    label: '邮箱', value: 'zhangsan.long.name@example.com', key: 'basic.email', entryIndex: 0,
  };
  if (!RA.datapanel._needsFullRow(it)) throw new Error('长邮箱应该独占整行');
});

// ─── 展开 / 收起 ───

check('默认全部展开（记录的是「收起」，不是「展开」）', () => {
  RA.datapanel._resetExpanded();
  for (const k of ['basic', 'jobIntention', 'education', 'work', 'project', 'emergency']) {
    if (!RA.datapanel._isExpanded(k)) throw new Error(`${k} 应该默认展开`);
  }
});

check('模块可以折叠和重新展开，互不影响', () => {
  RA.datapanel._resetExpanded();

  RA.datapanel._toggleModule('education');
  if (RA.datapanel._isExpanded('education')) throw new Error('应该被收起了');
  if (!RA.datapanel._isExpanded('basic')) throw new Error('收起一个不该影响别的模块');

  RA.datapanel._toggleModule('education');
  if (!RA.datapanel._isExpanded('education')) throw new Error('应该被重新展开了');

  RA.datapanel._resetExpanded();
  if (!RA.datapanel._isExpanded('education')) throw new Error('重置后应该全部展开');
});

check('面板初始是关闭状态', () => {
  if (RA.datapanel.isOpen()) throw new Error('初始不该是打开状态');
  if (RA.datapanel.getTarget() !== null) throw new Error('初始不该有选中目标');
});

// ─────────── 标注模式 ───────────

console.log('\n\x1b[1m标注模式\x1b[0m');

check('来自扩展浮层的点击不会被拦截', () => {
  // 这条出过一次真实故障：标注模式的点击拦截器挂在 document 捕获阶段，
  // 而选择面板也在 document 下面——不放行的话，点面板按钮时事件先被自己拦下来，
  // stopPropagation 一执行就传不到按钮上，整个面板点哪儿都没反应。
  const HOST = RA.overlay.HOST_ID;
  const node = (id, ignore) => ({
    nodeType: 1,
    id: id || '',
    hasAttribute: (a) => a === 'data-ra-ignore' && !!ignore,
  });

  const host = node(HOST, true);
  const innerBtn = node('', false);
  const pageInput = node('some-input', false);

  // 跨 shadow 边界时 e.target 会被重定向成宿主元素，拿不到里面真正的按钮，
  // 所以必须走 composedPath
  const onPanel = {
    target: host,
    composedPath: () => [innerBtn, host, globalThis.document],
  };
  if (!RA.pick.isFromOverlay(onPanel)) {
    throw new Error('浮层内的点击没被识别出来——面板会点不动');
  }

  const onPage = {
    target: pageInput,
    composedPath: () => [pageInput, globalThis.document],
  };
  if (RA.pick.isFromOverlay(onPage)) {
    throw new Error('页面元素的点击被误判成浮层事件，标注会失效');
  }
});

check('浮层判定不依赖 e.target（shadow DOM 下 target 会被重定向）', () => {
  // 只带 composedPath、没有 target 的事件也要能正确判断
  const host = { nodeType: 1, id: RA.overlay.HOST_ID, hasAttribute: () => true };
  const ev = { composedPath: () => [{ nodeType: 1, id: '', hasAttribute: () => false }, host] };
  if (!RA.pick.isFromOverlay(ev)) throw new Error('没有 target 时判断失败');
});

check('composedPath 不可用时退化为看 target，不会抛异常', () => {
  const host = { nodeType: 1, id: RA.overlay.HOST_ID, hasAttribute: () => true };
  if (!RA.pick.isFromOverlay({ target: host })) throw new Error('退化路径失败');
  const plain = { nodeType: 1, id: 'x', hasAttribute: () => false };
  if (RA.pick.isFromOverlay({ target: plain })) throw new Error('退化路径误判');
});

check('输入框选取模块导出了生命周期接口', () => {
  for (const fn of ['start', 'stop', 'isActive']) {
    if (typeof RA.pick[fn] !== 'function') throw new Error(`缺少 RA.pick.${fn}`);
  }
  if (RA.pick.isActive()) throw new Error('初始状态不该是激活的');
});

check('区块/字段标注功能已移除', () => {
  // 用户明确不要这套功能，数据面板取代了它。留这条测试防止以后又加回来。
  if (RA.overlay.showSectionPicker) throw new Error('showSectionPicker 不该存在');
  if (RA.overlay.showFieldPicker) throw new Error('showFieldPicker 不该存在');
  if (RA.main.fillRegion) throw new Error('fillRegion 不该存在');
  if (RA.main.locateControl) throw new Error('locateControl 不该存在');
  if (RA.pick.getMode) throw new Error('pick.getMode 不该存在');
});

// ─────────── 消息监听器 ───────────
console.log('\n\x1b[1m消息路由\x1b[0m');

check('只注册了一个 onMessage 监听器', () => {
  if (messageListeners.length !== 1) {
    throw new Error(`注册了 ${messageListeners.length} 个监听器，应该只有 1 个`);
  }
});

check('未知消息不被响应', () => {
  let responded = false;
  const r = messageListeners[0]({ type: 'SOMETHING_ELSE' }, {}, () => { responded = true; });
  if (responded) throw new Error('不该响应未知消息');
  if (r === true) throw new Error('不该保持通道打开');
});

check('RA_PING 立即应答', () => {
  let payload = null;
  messageListeners[0]({ type: 'RA_PING' }, {}, (p) => { payload = p; });
  if (!payload || !payload.ok) throw new Error('PING 没有正确应答');
});

// ─────────── 模板 ───────────

console.log('\n\x1b[1m模板\x1b[0m');

check('默认模板包含全部 15 个分组', () => {
  const tpl = RA.storage.buildDefaultTemplate();
  if (tpl.groups.length !== RA.fields.SECTION_ORDER.length) {
    throw new Error(`分组数不对：${tpl.groups.length}，应该是 ${RA.fields.SECTION_ORDER.length}`);
  }
  if (!tpl.id || !tpl.name) throw new Error('模板缺少 id 或 name');

  for (const g of tpl.groups) {
    if (!g.sectionKey) throw new Error('分组缺少 sectionKey');
    if (!g.title) throw new Error(g.sectionKey + ' 分组缺少标题');
    if (!g.fields.length) throw new Error(g.sectionKey + ' 分组里没有字段');
    for (const f of g.fields) {
      if (!f.key) throw new Error('字段缺少 key');
      if (!RA.fields.labelOf(f)) throw new Error(f.key + ' 取不到显示名');
    }
  }
});

check('模板里的字段 key 都能解析到定义', () => {
  const tpl = RA.storage.buildDefaultTemplate();
  for (const g of tpl.groups) {
    for (const f of g.fields) {
      if (!RA.fields.BY_KEY[f.key]) throw new Error('未知字段 key：' + f.key);
    }
  }
});

check('默认模板覆盖全部内置字段，一个不漏', () => {
  const tpl = RA.storage.buildDefaultTemplate();
  const keys = new Set(tpl.groups.flatMap((g) => g.fields.map((f) => f.key)));
  const missing = RA.fields.DEFS.filter((d) => !keys.has(d.key)).map((d) => d.key);
  if (missing.length) throw new Error('模板漏了：' + missing.join(', '));
});

check('分组顺序与 SECTION_ORDER 一致', () => {
  const tpl = RA.storage.buildDefaultTemplate();
  const got = tpl.groups.map((g) => g.sectionKey);
  const want = RA.fields.SECTION_ORDER.slice(0, got.length);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error('顺序不对：' + got.join(' → '));
  }
});

check('没存过模板时返回内置的「通用模板」', async () => {
  const state = await RA.storage.getTemplates();
  if (!Array.isArray(state.list) || !state.list.length) throw new Error('应该返回默认模板');
  if (!state.list.some((t) => t.id === RA.storage.DEFAULT_TEMPLATE_ID)) {
    throw new Error('内置模板不在列表里');
  }
});

check('没存过数据时返回一份默认简历', async () => {
  const state = await RA.storage.getResumes();
  if (!Array.isArray(state.list) || !state.list.length) throw new Error('应该返回默认简历');
  if (!state.list.some((r) => r.id === state.activeId)) {
    throw new Error('activeId 没有指向任何一份简历');
  }
  const r = state.list.find((x) => x.id === state.activeId);
  if (r.templateId !== RA.storage.DEFAULT_TEMPLATE_ID) {
    throw new Error('默认简历应该使用内置模板');
  }
});

check('内置字段的显示名不随模板改变', () => {
  // 用户不能改内置字段名——改了之后自己都对不上号。
  // 就算模板里存了个 label，也要以字段定义为准。
  const profile = { basic: { name: '张三' } };
  const template = {
    id: 't1', name: 'x',
    groups: [{
      sectionKey: 'basic',
      title: '我的信息',
      fields: [{ key: 'basic.name', label: '我自己起的名字' }],
    }],
  };

  const groups = RA.datapanel.buildGroups(profile, template);
  if (groups[0].title !== '我的信息') throw new Error('分组标题没听模板的');

  const label = groups[0].entries[0].items[0].label;
  if (label !== '姓名') throw new Error('内置字段名应该固定为「姓名」，实际是「' + label + '」');
});

check('模板里删掉的字段不出现在面板里', () => {
  const profile = { basic: { name: '张三', email: 'a@b.com' } };
  const template = {
    id: 't2', name: '只有姓名',
    groups: [{
      sectionKey: 'basic', title: '基本信息',
      fields: [{ key: 'basic.name', label: '姓名' }],
    }],
  };

  const groups = RA.datapanel.buildGroups(profile, template);
  const keys = groups[0].entries[0].items.map((i) => i.key);
  if (keys.includes('basic.email')) throw new Error('模板里没有邮箱，不该出现');
});

check('没有模板时退回内置全集', () => {
  const profile = { basic: { name: '张三' } };
  const groups = RA.datapanel.buildGroups(profile, null);
  if (!groups.length) throw new Error('应该退回内置全集');
  if (!groups.some((g) => g.key === 'basic')) throw new Error('缺少基本信息分组');
});

// ─────────── 自定义字段 ───────────

console.log('\n\x1b[1m自定义字段\x1b[0m');

check('labelOf：内置用定义名，自定义用用户起的名', () => {
  if (RA.fields.labelOf({ key: 'basic.name' }) !== '姓名') {
    throw new Error('内置字段名取错了');
  }
  if (RA.fields.labelOf({ key: 'custom.cf_1', label: '我的字段' }) !== '我的字段') {
    throw new Error('自定义字段名取错了');
  }
  if (RA.fields.labelOf({ key: 'custom.cf_2' }) === '') {
    throw new Error('没起名的自定义字段也要有个占位名');
  }
});

check('isCustom 判断正确', () => {
  if (!RA.fields.isCustom({ key: 'custom.x' })) throw new Error('custom.x 应该算自定义');
  if (RA.fields.isCustom({ key: 'basic.name' })) throw new Error('basic.name 不该算自定义');
  if (RA.fields.isCustom(null)) throw new Error('null 不该崩');
});

check('自定义字段的值从 profile.custom 里取', () => {
  const v = RA.fill.valueFor({ custom: { cf_1: 'abc' } }, 'custom.cf_1', 0);
  if (v !== 'abc') throw new Error('取不到：' + v);
});

check('自定义字段为空时返回 null，不瞎填', () => {
  if (RA.fill.valueFor({ custom: {} }, 'custom.cf_1', 0) !== null) throw new Error('空值应该是 null');
  if (RA.fill.valueFor({}, 'custom.cf_1', 0) !== null) throw new Error('没有 custom 时应该是 null');
  if (RA.fill.valueFor({ custom: { cf_1: '' } }, 'custom.cf_1', 0) !== null) {
    throw new Error('空串应该是 null');
  }
});

check('数据面板能显示自定义分组和自定义字段', () => {
  const profile = { custom: { cf_1: '自定义值' } };
  const template = {
    id: 't9', name: '含自定义',
    groups: [{
      sectionKey: null,
      title: '我的分组',
      fields: [{ key: 'custom.cf_1', label: '我的字段' }],
    }],
  };

  const groups = RA.datapanel.buildGroups(profile, template);
  if (!groups.length) throw new Error('自定义分组没出现');

  const item = groups[0].entries[0].items[0];
  if (item.label !== '我的字段') throw new Error('自定义字段名没听用户的：' + item.label);
  if (item.value !== '自定义值') throw new Error('值没取到：' + item.value);
});

check('profile.custom 能通过校验，不报未知字段', () => {
  const r = RA.storage.validateProfile({ custom: { cf_1: 'x' } });
  if (!r.ok) throw new Error('校验失败：' + JSON.stringify(r.errors));
  if (r.errors.some((e) => e.path === 'custom')) throw new Error('不该把 custom 当未知字段');
});

check('所有经历类字段都能从对应的数组里取到值', () => {
  // 这里防的是「数组名写死在正则里」那类 bug：漏掉一个数组，
  // 整个区块在数据面板里就是空的，自动填充也永远填不上。
  const bad = [];

  for (const section of Object.keys(RA.fields.ARRAY_NAME_BY_SECTION)) {
    const arrName = RA.fields.ARRAY_NAME_BY_SECTION[section];
    const defs = RA.fields.DEFS.filter((d) => d.section === section);

    const item = {};
    for (const d of defs) item[d.key.slice(d.key.indexOf('.') + 1)] = 'x';

    const profile = { [arrName]: [item] };

    for (const d of defs) {
      const v = RA.fill.valueFor(profile, d.key, 0);
      if (v !== 'x') bad.push(`${d.key} → ${v}`);
    }
  }

  if (bad.length) throw new Error('取不到值：' + bad.join('；'));
});

check('日期字段靠 key 就能认出来', () => {
  if (!RA.fill.isDateKey('educations.startDate')) throw new Error('startDate 没认出来');
  if (!RA.fill.isDateKey('basic.birthday')) throw new Error('birthday 没认出来');
  if (!RA.fill.isDateKey('certificates.date')) throw new Error('date 没认出来');
  if (RA.fill.isDateKey('basic.name')) throw new Error('name 被误认成日期');
  if (RA.fill.isDateKey('jobIntention.availableFrom')) throw new Error('到岗时间不该当日期');
});

// ─────────── 联想输入（学校 / 公司名称） ───────────

console.log('\n\x1b[1m联想输入识别\x1b[0m');

function fakeInput(attrs) {
  return {
    readOnly: true,
    disabled: false,
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
    },
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(attrs, k);
    },
    closest() { return null; },
    matches() { return false; },
    getBoundingClientRect() { return { width: 200, height: 32 }; },
  };
}

check('readonly 但带「请选择学校」提示的框不会被当成只读计算字段跳过', () => {
  // 学校/公司这类选择器经常没有约定类名，只有 readonly + 提示语。
  // 以前一律按 readonly 跳过，表现就是「这个字段根本检测不到」。
  if (RA.scan.shouldSkip(fakeInput({ placeholder: '请选择学校' }))) {
    throw new Error('应该放行');
  }
  if (RA.scan.shouldSkip(fakeInput({ 'aria-autocomplete': 'list' }))) {
    throw new Error('aria-autocomplete 应该放行');
  }
  if (!RA.scan.shouldSkip(fakeInput({ placeholder: '系统自动计算' }))) {
    throw new Error('没有选择器特征的 readonly 仍然应该跳过');
  }
});

check('标签是简历字段的可搜索下拉，不会被当成站点搜索框丢掉', () => {
  // placeholder 写「请输入关键字搜索」在可搜索下拉里非常常见，
  // 但它的标签是「专业」「学校名称」，是正经表单字段。
  // 早先按 placeholder 一律当搜索框丢弃，这类字段直接「检测不到」。
  const sig = (labelText, placeholder) => ({ labelText, placeholder, name: '', id: '' });

  if (RA.scan.isJunk(sig('专业', '请输入关键字搜索'))) {
    throw new Error('「专业」可搜索下拉被误删');
  }
  if (RA.scan.isJunk(sig('学校名称', '搜索学校名称'))) {
    throw new Error('「学校名称」可搜索下拉被误删');
  }
  if (!RA.scan.isJunk(sig('搜索', '搜索职位'))) {
    throw new Error('站点搜索框应该被丢弃');
  }
  if (!RA.scan.isJunk(sig('验证码', '请输入验证码'))) {
    throw new Error('验证码应该被丢弃');
  }
});

check('学校 / 公司 / 专业被识别为可能有联想列表的字段', () => {
  const el = { getAttribute: () => null };
  const mk = (key, signals) => ({ raKey: key, el, signals: signals || {} });

  if (!RA.fill.mayAutocomplete(mk('educations.school'))) throw new Error('学校应该识别');
  if (!RA.fill.mayAutocomplete(mk('works.company'))) throw new Error('公司应该识别');
  if (!RA.fill.mayAutocomplete(mk('educations.major'))) throw new Error('专业应该识别');

  if (RA.fill.mayAutocomplete(mk('basic.name'))) throw new Error('姓名不该识别');
  if (RA.fill.mayAutocomplete(mk('basic.phone'))) throw new Error('电话不该识别');

  if (!RA.fill.mayAutocomplete(mk('basic.city', { placeholder: '请输入学校名称' }))) {
    throw new Error('提示语指向学校时应该识别');
  }
});

// ─────────── 悬浮按钮的出现条件 ───────────

function fakeField(attrs) {
  return {
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
    },
  };
}

/** 临时换掉 document / location，模拟一次页面判断 */
function withDom(opts, fn) {
  const savedDoc = globalThis.document;
  const savedLoc = globalThis.location;

  const fields = opts.fields || [];
  const headings = opts.headings || [];

  globalThis.document = {
    title: opts.title || '',
    querySelectorAll(sel) {
      if (sel === 'input, select, textarea') return fields;
      if (sel === 'h1, h2, h3') return headings;
      return [];
    },
    querySelector(sel) {
      if (sel === 'input[type="password"]') return opts.password ? fakeField({}) : null;
      if (sel.indexOf('type="file"') >= 0) return opts.upload ? fakeField({}) : null;
      return null;
    },
  };
  globalThis.location = { href: opts.url || 'https://example.com/' };

  try {
    fn();
  } finally {
    globalThis.document = savedDoc;
    globalThis.location = savedLoc;
  }
}

check('标题带招聘词的表单页 → 显示悬浮按钮', () => {
  withDom({
    title: '校园招聘 - 网申',
    fields: [fakeField({ name: 'a' }), fakeField({ name: 'b' }), fakeField({ name: 'c' })],
  }, () => {
    if (!RA.main.looksLikeResumePage()) throw new Error('应该判定为简历页');
  });
});

check('普通页面的搜索框 → 不显示', () => {
  withDom({
    title: '某博客 - 搜索',
    fields: [fakeField({ name: 'q' }), fakeField({ name: 'q2' })],
  }, () => {
    if (RA.main.looksLikeResumePage()) throw new Error('不该判定为简历页');
  });
});

check('登录/注册页即使有个人信息字段也不显示', () => {
  withDom({
    title: '登录',
    password: true,
    fields: [
      fakeField({ name: 'name', placeholder: '姓名' }),
      fakeField({ name: 'phone', placeholder: '手机号' }),
      fakeField({ name: 'email', placeholder: '邮箱' }),
      fakeField({ name: 'pwd', type: 'password' }),
      fakeField({ name: 'pwd2', type: 'password' }),
    ],
  }, () => {
    if (RA.main.looksLikeResumePage()) throw new Error('登录页不该显示');
  });
});

check('有简历上传框 + 一个字段命中 → 显示', () => {
  withDom({
    title: '职位申请',
    upload: true,
    fields: [
      fakeField({ name: 'name', placeholder: '姓名' }),
      fakeField({ name: 'x' }),
      fakeField({ name: 'y' }),
    ],
  }, () => {
    if (!RA.main.looksLikeResumePage()) throw new Error('应该判定为简历页');
  });
});

check('五个框 + 三个个人信息字段 → 显示', () => {
  withDom({
    title: '填写信息',
    fields: [
      fakeField({ name: 'a', placeholder: '姓名' }),
      fakeField({ name: 'b', placeholder: '手机号' }),
      fakeField({ name: 'c', placeholder: '邮箱' }),
      fakeField({ name: 'd' }),
      fakeField({ name: 'e' }),
    ],
  }, () => {
    if (!RA.main.looksLikeResumePage()) throw new Error('应该判定为简历页');
  });
});

check('字段太少时不显示（避免联系表单误报）', () => {
  withDom({
    title: '联系我们',
    fields: [
      fakeField({ name: 'a', placeholder: '姓名' }),
      fakeField({ name: 'b', placeholder: '手机号' }),
      fakeField({ name: 'c', placeholder: '邮箱' }),
      fakeField({ name: 'd', placeholder: '留言' }),
    ],
  }, () => {
    if (RA.main.looksLikeResumePage()) throw new Error('4 个框的联系表单不该显示');
  });
});

// ─────────── 汇总 ───────────

Promise.all(pending).then(() => {
  console.log('\n' + '─'.repeat(52));
  if (failed === 0) {
    console.log(`\x1b[32m全部通过\x1b[0m  ${passed} 项`);
  } else {
    console.log(`\x1b[31m失败 ${failed} 项\x1b[0m，通过 ${passed} 项`);
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  }
  process.exit(failed === 0 ? 0 : 1);
});
