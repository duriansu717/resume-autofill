/**
 * 匹配引擎的单元测试。
 *
 * 不需要浏览器——直接构造描述符对象喂给打分器。
 * 覆盖的都是「如果不特意处理就一定会错」的场景。
 *
 * 运行：node test/engine.test.js
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
  // 20-section.js 只需要 RA.scan 存在（模块级只是取了个引用），
  // 而 classifySectionKind 本身是纯函数，不碰 DOM，可以直接在 Node 里测
  'src/content/20-section.js',
  'src/content/30-score.js',
]) {
  const file = path.join(ROOT, f);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

const RA = globalThis.RA;
const N = RA.normalize;

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

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '不相等') + `：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// ─────────────────────── 构造描述符 ───────────────────────

let domIdx = 0;

/**
 * 造一个描述符。signals 只需给出关心的部分，其余给默认值。
 */
function mk(signals, section) {
  return {
    el: { __id: domIdx },   // 只需是个唯一对象
    kind: signals.kind || 'text',
    domIndex: domIdx++,
    signals: {
      autocomplete: '',
      name: '',
      id: '',
      labelText: '',
      labelSource: 'for',
      placeholder: '',
      placeholderIsValueLike: false,
      placeholderIsDescriptive: false,
      ariaLabel: '',
      title: '',
      inputType: 'text',
      maxLength: null,
      className: '',
      nearbyText: [],
      optionTexts: [],
      ...signals,
    },
    section: section === undefined
      ? { key: null, title: '', confidence: 0, rootEl: null }
      : { key: section.key, title: section.title || section.key, confidence: 0.9,
          entryIndex: section.entryIndex ?? 0, rootEl: null },
  };
}

/** 取某个描述符匹配到的最佳 key */
function topKey(d) {
  const r = RA.score.scoreField(d, RA.fields.DEFS.map((x) => x.key));
  return r.length ? r[0] : null;
}

function topKeyName(d) {
  const t = topKey(d);
  return t ? t.key : null;
}

/** 某 key 在结果里的分数，没有则 0 */
function scoreOf(d, key) {
  const r = RA.score.scoreField(d, [key]);
  return r.length ? r[0].score : 0;
}

// ═══════════════════════ 归一化 ═══════════════════════

console.log('\n\x1b[1m归一化\x1b[0m');

check('全角转半角并去标点', () => {
  assertEq(N.text('手机号码：'), '手机号码');
  assertEq(N.text('Ｅｍａｉｌ'), 'email');
});

check('camelCase 拆词', () => {
  assertEq(N.spaced('userName'), 'user name');
  assertEq(N.spaced('user_phone_num'), 'user phone num');
  assertEq(N.spaced('HTTPServer'), 'http server');
});

check('差异：大小写与空格不影响归一化', () => {
  assertEq(N.text('User Name'), N.text('username'));
});

check('日期解析覆盖常见写法', () => {
  assertEq(JSON.stringify(N.dateParts('1998-07-15')), JSON.stringify({ y: 1998, m: 7, d: 15 }));
  assertEq(JSON.stringify(N.dateParts('1998/7/15')), JSON.stringify({ y: 1998, m: 7, d: 15 }));
  assertEq(JSON.stringify(N.dateParts('1998年7月')), JSON.stringify({ y: 1998, m: 7, d: null }));
  assertEq(JSON.stringify(N.dateParts('2020-07')), JSON.stringify({ y: 2020, m: 7, d: null }));
  assertEq(JSON.stringify(N.dateParts('2020')), JSON.stringify({ y: 2020, m: null, d: null }));
  assertEq(N.dateParts('不是日期'), null);
  assertEq(N.dateParts('2020-13-01'), null);
});

check('英文别名按词边界匹配，不再退化成子串匹配', () => {
  const hay = N.spaced('phoneNumber');
  // 'phone' 在 camelCase 拆词后是独立词
  assertEq(N.matchAlias('phone', N.text(hay), hay), 1, 'phone 应该词边界命中');
  // 'one' 只是 phoneNumber 的子串，不该拿到词边界的满分
  assert(N.matchAlias('one', N.text(hay), hay) < 1, 'one 只是子串，不该按词边界命中');
});

check('camelCase 组件确实会命中 name，但由反向别名负责压制', () => {
  // 词边界层面 username 里的 name 确实算命中——这是共同的词边界逻辑决定的，
  // 单看这一层无法区分「姓名」和「用户名」。
  const hay = N.spaced('userName');
  assertEq(N.matchAlias('name', N.text(hay), hay), 1, '词边界确实命中');

  // 真正的抑制发生在打分层的 negative 别名上
  const d = mk({ name: 'userName', labelSource: 'none' });
  const s = scoreOf(d, 'basic.name');
  assert(s < 0.4, `userName 对 basic.name 的最终得分应该很低，实际 ${s.toFixed(2)}`);
});

// ═══════════════════════ 基础匹配 ═══════════════════════

console.log('\n\x1b[1m基础字段匹配\x1b[0m');

check('label 手机号码 + type=tel + maxlength=11 → basic.phone', () => {
  const d = mk({ labelText: '手机号码', inputType: 'tel', maxLength: 11 });
  assertEq(topKeyName(d), 'basic.phone');
});

check('label 电子邮箱 + type=email → basic.email', () => {
  const d = mk({ labelText: '电子邮箱', inputType: 'email' });
  assertEq(topKeyName(d), 'basic.email');
});

check('autocomplete=tel 直接锁定 basic.phone', () => {
  const d = mk({ autocomplete: 'tel' });
  assertEq(topKeyName(d), 'basic.phone');
});

check('maxlength=18 的证件号码 → basic.idCard', () => {
  const d = mk({ labelText: '证件号码', maxLength: 18 });
  assertEq(topKeyName(d), 'basic.idCard');
});

check('「毕业院校」→ educations.school 而不是 projects.name', () => {
  const d = mk({ labelText: '毕业院校' }, { key: 'education' });
  assertEq(topKeyName(d), 'educations.school');
});

check('多行文本框 + 工作内容 → works.description', () => {
  const d = mk({ labelText: '工作内容', kind: 'textarea' }, { key: 'work' });
  assertEq(topKeyName(d), 'works.description');
});

// ═══════════════════════ 反向别名 ═══════════════════════

console.log('\n\x1b[1m反向别名（防止误伤）\x1b[0m');

check('「用户名」不应该匹配到 basic.name', () => {
  const d = mk({ labelText: '用户名', name: 'username' });
  const nameScore = scoreOf(d, 'basic.name');
  assert(nameScore < 0.5, `basic.name 得分应该被压低，实际 ${nameScore.toFixed(2)}`);
});

check('「公司名称」不应该匹配到 basic.name', () => {
  const d = mk({ labelText: '公司名称' });
  const surname = scoreOf(d, 'basic.name');
  const company = scoreOf(d, 'works.company');
  assert(company > surname, `公司名应该更匹配 works.company（${company.toFixed(2)} vs ${surname.toFixed(2)}）`);
});

check('含「用户名」的登录框，basic.name 不得分高于 0.5', () => {
  const d = mk({ labelText: '用户名', name: 'user_name', placeholder: '请输入用户名' });
  assert(scoreOf(d, 'basic.name') < 0.5, 'basic.name 分数过高');
});

// ═══════════════════════ 区块消歧 ═══════════════════════

console.log('\n\x1b[1m区块消歧（最关键的部分）\x1b[0m');

check('教育经历里的「开始时间」→ educations.startDate', () => {
  const d = mk({ labelText: '开始时间' }, { key: 'education' });
  const edu = scoreOf(d, 'educations.startDate');
  const work = scoreOf(d, 'works.startDate');
  assert(edu > work, `教育区块下应偏向前者：edu=${edu.toFixed(2)} work=${work.toFixed(2)}`);
});

check('工作经历里的「开始时间」→ works.startDate', () => {
  const d = mk({ labelText: '开始时间' }, { key: 'work' });
  const edu = scoreOf(d, 'educations.startDate');
  const work = scoreOf(d, 'works.startDate');
  assert(work > edu, `工作区块下应偏向后者：edu=${edu.toFixed(2)} work=${work.toFixed(2)}`);
});

check('「入学时间」无论区块如何都指向教育经历', () => {
  const d = mk({ labelText: '入学时间' });  // 无区块信息
  assertEq(topKeyName(d), 'educations.startDate');
});

check('「离职时间」无论区块如何都指向工作经历', () => {
  const d = mk({ labelText: '离职时间' });
  assertEq(topKeyName(d), 'works.endDate');
});

check('区块不匹配时分数被明显压低', () => {
  const inEdu = mk({ labelText: '开始时间' }, { key: 'education' });
  const inProj = mk({ labelText: '开始时间' }, { key: 'project' });
  assert(
    scoreOf(inEdu, 'educations.startDate') > scoreOf(inProj, 'educations.startDate'),
    '区块匹配的应该更高'
  );
});

// ═══════════════════════ 全局分配 ═══════════════════════

console.log('\n\x1b[1m全局分配\x1b[0m');

check('同页两个「开始时间」分别落到教育和工作，且互不抢占', () => {
  const eduStart = mk({ labelText: '开始时间' }, { key: 'education', entryIndex: 0 });
  const workStart = mk({ labelText: '开始时间' }, { key: 'work', entryIndex: 0 });
  const matches = RA.score.match([eduStart, workStart]);
  const byEl = new Map(matches.map((m) => [m.d.el, m.key]));
  assertEq(byEl.get(eduStart.el), 'educations.startDate');
  assertEq(byEl.get(workStart.el), 'works.startDate');
});

check('同字段在两条不同经历里都能被填（不同槽位）', () => {
  const e0 = mk({ labelText: '学校名称' }, { key: 'education', entryIndex: 0 });
  const e1 = mk({ labelText: '学校名称' }, { key: 'education', entryIndex: 1 });
  const matches = RA.score.match([e0, e1]);
  assertEq(matches.length, 2, '两条经历都应该匹配上');
  assert(matches.every((m) => m.key === 'educations.school'));
});

check('单个字段只占用一个控件（不被重复匹配）', () => {
  const a = mk({ labelText: '手机号码', inputType: 'tel' });
  const b = mk({ labelText: '联系电话', inputType: 'tel' });
  const matches = RA.score.match([a, b]);
  const phoneCount = matches.filter((m) => m.key === 'basic.phone').length;
  assertEq(phoneCount, 1, 'basic.phone 只应该占用一个控件');
});

// ═══════════════════════ 枚举指纹 ═══════════════════════

console.log('\n\x1b[1m枚举指纹\x1b[0m');

check('只有「男/女」两个选项的下拉被识别为性别', () => {
  const d = mk({
    kind: 'select',
    optionTexts: ['男', '女'],
    labelText: '',
    name: 'field_123',
  });
  assertEq(topKeyName(d), 'basic.gender');
});

check('学历下拉被识别为学历', () => {
  const d = mk({
    kind: 'select',
    optionTexts: ['大专', '本科', '硕士', '博士'],
    name: 'f_88',
  });
  assertEq(topKeyName(d), 'educations.degree');
});

check('从 id / name 推断区块和「第几条经历」', () => {
  const mkNode = (attrs, parent) => ({
    parentElement: parent || null,
    getAttribute(k) {
      return attrs && Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
    },
  });

  const direct = RA.section.sectionFromId(mkNode({ id: 'resume_education_form_time[0]' }));
  assertEq(direct.key, 'education');
  assertEq(direct.entryIndex, 0);

  // 输入框自己没有 id，但祖先容器有
  const parent = mkNode({ id: 'resume_education_form_time[1]' });
  const child = mkNode({}, parent);
  const inherited = RA.section.sectionFromId(child);
  assertEq(inherited.key, 'education');
  assertEq(inherited.entryIndex, 1);

  // 字段名里的 school 不算区块词，否则 schoolEmail 会被误判成教育经历
  assertEq(RA.section.sectionFromId(mkNode({ id: 'schoolEmail' })), null);

  assertEq(RA.section.entryIndexFromId('education[0].school'), 0);
  assertEq(RA.section.entryIndexFromId('work_experience_2_company'), 2);
});

check('「学校所在地」不会被当成学校名，真正的学校字段能拿回槽位', () => {
  // 网申页面同时有「学校所在地」（城市）和「学校」（下拉）。
  // 学校的别名「学校」命中「学校所在地」，抢走了 school 槽位，
  // 结果城市框被填成学校名，真正的学校下拉反而没填。
  const city = mk({
    labelText: '学校所在地', labelSource: 'for',
    id: 'schoolCityCode', nearbyText: ['学校所在地'],
  });
  const school = mk({
    labelText: '学校', labelSource: 'for',
    id: 'resume_education_form_schoolId[0]',
  });

  const matches = RA.score.match([city, school]);
  const byD = new Map(matches.map((m) => [m.d, m.key]));

  assertEq(byD.get(city), 'educations.city', '学校所在地');
  assertEq(byD.get(school), 'educations.school', '学校');
});

check('「时间 / 至」区间：入学与毕业都能过填充阈值', () => {
  // 网易网申的样子：两个日期控件共用一个「时间」标签，
  // 开始框靠 placeholder「入校时间」，结束框靠中间的「至」。
  const section = { key: 'education', entryIndex: 0 };
  const start = mk({
    labelText: '时间', labelSource: 'framework',
    placeholder: '入校时间',
    className: 'ant-calendar-picker-input ant-input',
    nearbyText: ['时间 至'],
  }, section);
  const end = mk({
    labelText: '至', labelSource: 'geometric',
    placeholder: '按“yyyy-mm”格式输入',
    className: 'ant-calendar-picker-input ant-input',
  }, section);

  const matches = RA.score.match([start, end]);
  const byD = new Map(matches.map((m) => [m.d, m]));

  assertEq(byD.get(start) && byD.get(start).key, 'educations.startDate', '入学时间');
  assertEq(byD.get(end) && byD.get(end).key, 'educations.endDate', '毕业时间');

  // 低于 0.5 的话 doFill 会直接跳过，等于没填
  assert(byD.get(end).score >= 0.5, '结束时间的分数没过填充阈值：' + byD.get(end).score.toFixed(2));
});

check('所在学院 / 导师 / 荣誉奖项有对应字段', () => {
  assertEq(topKeyName(mk({ labelText: '所在学院', labelSource: 'for' })), 'educations.college');
  assertEq(topKeyName(mk({ labelText: '导师姓名', labelSource: 'for' })), 'educations.mentor');
  assertEq(topKeyName(mk({ labelText: '导师', labelSource: 'for' })), 'educations.mentor');
  assertEq(topKeyName(mk({ kind: 'textarea', labelText: '荣誉奖项', labelSource: 'for' })), 'educations.honors');
});

check('组件内部 0×0 的隐藏 input 不参与匹配', () => {
  // atsx-date-picker-period-hidden-input 这类控件只负责存值，
  // 真正可操作的是它旁边可见的选择器。让它参与匹配只会抢走槽位。
  const d = mk({ hiddenInternal: true, labelText: '在校时间', labelSource: 'for' });
  const r = RA.score.scoreField(d, ['educations.startDate', 'educations.endDate']);
  assertEq(r.length, 0, '隐藏 input 不该产生任何候选');
});

check('没有区块标题时，靠旁边的学校 / 公司字段判定日期属于哪个模块', () => {
  // 表格布局：一行是教育（学校名称 + 开始/结束时间），一行是工作（公司名称 + …），
  // 全页没有「教育经历 / 工作经历」标题。日期字段只能靠同行的字段确定归属。
  const root = { parentElement: null, children: [] };
  const makeNode = (parent) => {
    const n = {
      parentElement: parent,
      children: [],
      contains(x) {
        let p = x;
        while (p) { if (p === n) return true; p = p.parentElement; }
        return false;
      },
    };
    if (parent) parent.children.push(n);
    return n;
  };

  const row1 = makeNode(root);
  const row2 = makeNode(root);
  const td = (row) => makeNode(row);
  const inputIn = (cell) => ({ parentElement: cell });

  const eduRow = {
    school: inputIn(td(row1)),
    start: inputIn(td(row1)),
    end: inputIn(td(row1)),
  };
  const workRow = {
    company: inputIn(td(row2)),
    start: inputIn(td(row2)),
    end: inputIn(td(row2)),
  };

  const mkCell = (signals, el) => {
    const d = mk(Object.assign({ labelSource: 'cell' }, signals));
    d.el = el;
    return d;
  };

  const school = mkCell({ labelText: '学校名称' }, eduRow.school);
  const eduStart = mkCell({ labelText: '开始时间' }, eduRow.start);
  const eduEnd = mkCell({ labelText: '结束时间' }, eduRow.end);
  const company = mkCell({ labelText: '公司名称' }, workRow.company);
  const workStart = mkCell({ labelText: '开始时间' }, workRow.start);
  const workEnd = mkCell({ labelText: '结束时间' }, workRow.end);

  const matches = RA.score.match([school, eduStart, eduEnd, company, workStart, workEnd]);
  const byEl = new Map(matches.map((m) => [m.d, m.key]));

  assertEq(byEl.get(eduStart), 'educations.startDate', '教育行的开始时间');
  assertEq(byEl.get(eduEnd), 'educations.endDate', '教育行的结束时间');
  assertEq(byEl.get(workStart), 'works.startDate', '工作行的开始时间');
  assertEq(byEl.get(workEnd), 'works.endDate', '工作行的结束时间');
});

check('同一个「起止时间」标签下的两个日期控件，分别归到入学 / 毕业时间', () => {
  // 网申常见布局：一个表单项里放两个日期控件，标签只写「起止时间」。
  // 两个控件的标签完全一样，只能靠「一个槽位只能占一次」的全局分配来区分。
  const section = { key: 'education', entryIndex: 0 };
  const a = mk({ labelText: '起止时间', labelSource: 'container' }, section);
  const b = mk({ labelText: '起止时间', labelSource: 'container' }, section);

  const matches = RA.score.match([a, b]);
  const keys = matches.filter((m) => m.d === a || m.d === b).map((m) => m.key);

  if (!keys.includes('educations.startDate') || !keys.includes('educations.endDate')) {
    throw new Error('两个日期控件应该分别拿到入学/毕业时间，实际：' + keys.join(', '));
  }
});

check('「学历类型」是学习形式，不是学历层次', () => {
  // 网申里常见的坑：「学历」问本科/硕士，「学历类型」问全日制/非全日制。
  // 早先 degree 把「学历类型」写成负别名，却没有字段接住它，结果谁也填不上。
  const d = mk({
    kind: 'select',
    labelText: '学历类型',
    labelSource: 'for',
    optionTexts: ['全日制', '非全日制'],
  });
  assertEq(topKeyName(d), 'educations.isFullTime');
  assert(scoreOf(d, 'educations.isFullTime') > scoreOf(d, 'educations.degree'),
    '学习形式的分数应该高于学历');
});

check('只有「全日制 / 非全日制」选项的下拉被识别为学习形式', () => {
  const d = mk({ kind: 'select', optionTexts: ['全日制', '非全日制'], name: 'f_99' });
  assertEq(topKeyName(d), 'educations.isFullTime');
});

check('婚否选项被识别为婚姻状况', () => {
  const d = mk({ kind: 'select', optionTexts: ['未婚', '已婚', '离异'] });
  assertEq(topKeyName(d), 'basic.maritalStatus');
});

// ═══════════════════════ 类型约束 ═══════════════════════

console.log('\n\x1b[1m类型约束\x1b[0m');

check('type=email 的框不会匹配到姓名', () => {
  const d = mk({ inputType: 'email', labelText: '邮箱', name: 'a' });
  assertEq(scoreOf(d, 'basic.name'), 0, 'email 框不应该匹配姓名');
});

check('type=number 的框不会匹配到姓名', () => {
  const d = mk({ inputType: 'number', name: 'x' });
  assert(scoreOf(d, 'basic.name') < 0.2, '数字框不应该匹配姓名');
});

check('单行输入框承担大段描述时被降权', () => {
  const single = mk({ labelText: '自我评价', inputType: 'text', kind: 'text' });
  const multi = mk({ labelText: '自我评价', kind: 'textarea' });
  assert(
    scoreOf(multi, 'basic.selfEvaluation') > scoreOf(single, 'basic.selfEvaluation'),
    '多行框应该比单行框更匹配自我评价'
  );
});

// ═══════════════════════ 权重合理性 ═══════════════════════

console.log('\n\x1b[1m证据权重\x1b[0m');

check('一个权威 label 胜过一堆弱信号', () => {
  // 权威：label 明写「手机号码」
  const authoritative = mk({ labelText: '手机号码', labelSource: 'for' });
  // 弱信号堆：name、id、class、nearby 都沾一点边，但没有明确标签
  const noisy = mk({
    name: 'contactPhone',
    id: 'phone_field',
    className: 'phone-input',
    nearbyText: ['电话', '联系方式'],
    labelSource: 'none',
  });
  assert(
    scoreOf(authoritative, 'basic.phone') >= scoreOf(noisy, 'basic.phone'),
    '权威标签不应该被一堆弱信号盖过'
  );
});

check('示例值型 placeholder 权重远低于描述型', () => {
  const descriptive = mk({
    placeholder: '请输入手机号',
    placeholderIsDescriptive: true,
    labelSource: 'none',
  });
  const valueLike = mk({
    placeholder: '13800138000',
    placeholderIsValueLike: true,
    labelSource: 'none',
  });
  const a = scoreOf(descriptive, 'basic.phone');
  const b = scoreOf(valueLike, 'basic.phone');
  assert(a > b, `描述型(${a.toFixed(2)}) 应该明显高于示例值型(${b.toFixed(2)})`);
});

check('name 属性里的手机语义能被识别', () => {
  const d = mk({ name: 'user_phone', labelSource: 'none' });
  assertEq(topKeyName(d), 'basic.phone');
});

// ═══════════════════════ 日期 ═══════════════════════

console.log('\n\x1b[1m日期字段\x1b[0m');

check('出生日期 → basic.birthday', () => {
  const d = mk({ labelText: '出生日期' });
  assertEq(topKeyName(d), 'basic.birthday');
});

check('拆分日期组匹配到日期字段而非文本字段', () => {
  const d = mk({ labelText: '出生日期', kind: 'date-cluster' });
  assertEq(topKeyName(d), 'basic.birthday');
});

check('入学/毕业时间在同一区块下被正确区分', () => {
  const start = mk({ labelText: '入学时间' }, { key: 'education' });
  const end = mk({ labelText: '毕业时间' }, { key: 'education' });
  assertEq(topKeyName(start), 'educations.startDate');
  assertEq(topKeyName(end), 'educations.endDate');
});

// ═══════════════════════ 扩充字段 ═══════════════════════

console.log('\n\x1b[1m扩充字段\x1b[0m');

check('求职意向的行业 / 公司类型 / 职级', () => {
  assertEq(topKeyName(mk({ labelText: '期望行业' })), 'jobIntention.industry');
  assertEq(topKeyName(mk({ labelText: '期望公司类型' })), 'jobIntention.companyType');
  assertEq(topKeyName(mk({ labelText: '期望职级' })), 'jobIntention.positionLevel');
});

check('工作经历的公司规模 / 下属人数 / 汇报对象', () => {
  assertEq(topKeyName(mk({ labelText: '公司规模' }, { key: 'work' })), 'works.companyScale');
  assertEq(topKeyName(mk({ labelText: '下属人数' }, { key: 'work' })), 'works.subordinates');
  assertEq(topKeyName(mk({ labelText: '汇报对象' }, { key: 'work' })), 'works.reportingTo');
});

check('教育经历的专业排名 / 主修课程 / 辅修专业', () => {
  assertEq(topKeyName(mk({ labelText: '专业排名' }, { key: 'education' })), 'educations.rank');
  assertEq(topKeyName(mk({ labelText: '主修课程' }, { key: 'education' })), 'educations.courses');
  assertEq(topKeyName(mk({ labelText: '辅修专业' }, { key: 'education' })), 'educations.minorMajor');
});

check('户籍与籍贯是两个不同的字段', () => {
  assertEq(topKeyName(mk({ labelText: '籍贯' })), 'basic.hometown');
  assertEq(topKeyName(mk({ labelText: '户口所在地' })), 'basic.hukou');
  assertEq(topKeyName(mk({ labelText: '户籍所在地' })), 'basic.hukou');
});

check('证书名称不会被当成姓名或项目名', () => {
  const d = mk({ labelText: '证书名称' }, { key: 'certificate' });
  assertEq(topKeyName(d), 'certificates.name');
  assert(scoreOf(d, 'basic.name') < 0.3, 'basic.name 不该拿到高分');
});

check('紧急联系人姓名不会被当成本人姓名', () => {
  const d = mk({ labelText: '紧急联系人姓名' }, { key: 'emergency' });
  assertEq(topKeyName(d), 'emergency.name');
  assert(scoreOf(d, 'basic.name') < 0.3, 'basic.name 不该拿到高分');
});

check('奖项名称不会被当成证书或项目名', () => {
  const d = mk({ labelText: '奖项名称' }, { key: 'award' });
  assertEq(topKeyName(d), 'awards.name');
});

check('语种 / 掌握程度', () => {
  assertEq(topKeyName(mk({ labelText: '语种' }, { key: 'language' })), 'languages.name');
  assertEq(topKeyName(mk({ labelText: '掌握程度' }, { key: 'language' })), 'languages.level');
});

// ═══════════════════════ 区块标题识别 ═══════════════════════

console.log('\n\x1b[1m区块标题识别\x1b[0m');

const C = RA.section.classifySectionKind;

check('各区块的标题都能被认出来', () => {
  const cases = {
    基本信息: 'basic', 个人信息: 'basic', 联系方式: 'basic',
    求职意向: 'jobIntention',
    教育经历: 'education', 教育背景: 'education',
    工作经历: 'work', 工作经验: 'work',
    实习经历: 'internship',
    项目经历: 'project', 项目经验: 'project',
    证书信息: 'certificate', 资格证书: 'certificate',
    语言能力: 'language', 外语水平: 'language',
    获奖情况: 'award', 荣誉奖项: 'award',
    校园经历: 'campus', 社会实践: 'campus',
    培训经历: 'training',
    紧急联系人: 'emergency',
  };
  for (const [text, expected] of Object.entries(cases)) {
    assertEq(C(text), expected, `「${text}」`);
  }
});

check('字段标签不会被误判成区块标题', () => {
  // 这些是字段标签，不是区块标题——认错了会把整块字段归错区
  for (const label of ['姓名', '手机号码', '电子邮箱', '身份证号', '出生日期',
                       '开始时间', '结束时间', '公司名称', '职位名称', '自我评价']) {
    assertEq(C(label), null, `「${label}」不该被当成区块标题`);
  }
});

check('「语言能力」按区块处理，而不是被字段别名「语言」抢走', () => {
  // 这是新增区块后最容易踩的坑：区块别名 4 字 vs 字段别名 2 字，应该听区块的
  assertEq(C('语言能力'), 'language');
});

check('英文标题也能识别', () => {
  assertEq(C('Education'), 'education');
  assertEq(C('WORK EXPERIENCE'), 'work');
  assertEq(C('Projects'), 'project');
});

check('不相关文字返回 null', () => {
  assertEq(C('温馨提示'), null);
  assertEq(C('这是一段很长的说明文字用来测试长度上限应该被拒绝'), null);
  assertEq(C(''), null);
});

// ═══════════════════════ 网申表单字段（网易游戏实测结构） ═══════════════════════

console.log('\n\x1b[1m网申表单字段\x1b[0m');

check('个人信息：证件类型 / 学校邮箱 / 家庭电话', () => {
  assertEq(topKeyName(mk({ labelText: '证件类型', kind: 'select' })), 'basic.idType');
  assertEq(topKeyName(mk({ labelText: '学校邮箱', inputType: 'email' })), 'basic.schoolEmail');
});

check('「家庭电话」不会被当成主手机号', () => {
  const d = mk({ labelText: '家庭电话', inputType: 'tel' });
  assertEq(topKeyName(d), 'basic.homePhone');
  assert(scoreOf(d, 'basic.phone') < scoreOf(d, 'basic.homePhone'), '主手机不应该抢走家庭电话');
});

check('教育背景：实验室', () => {
  assertEq(topKeyName(mk({ labelText: '实验室' }, { key: 'education' })), 'educations.lab');
});

check('工作经历：工作属性', () => {
  assertEq(topKeyName(mk({ labelText: '工作属性', kind: 'select' }, { key: 'work' })), 'works.employmentType');
});

check('实践经历：大赛名称 / 大赛成绩', () => {
  assertEq(topKeyName(mk({ labelText: '大赛名称' }, { key: 'competition' })), 'competitions.name');
  assertEq(topKeyName(mk({ labelText: '大赛成绩' }, { key: 'competition' })), 'competitions.result');
});

check('学生干部经历：任职组织 / 任职时间', () => {
  assertEq(topKeyName(mk({ labelText: '任职组织' }, { key: 'studentCadre' })),
    'studentCadreExperiences.organization');
  assertEq(topKeyName(mk({ labelText: '任职时间' }, { key: 'studentCadre' })),
    'studentCadreExperiences.startDate');
});

check('IT技能：技能名称', () => {
  assertEq(topKeyName(mk({ labelText: '技能名称' }, { key: 'itSkill' })), 'itSkills.name');
});

// ─── 同一标签在不同区块下必须落到不同字段 ───
// 这是网申表单最典型的结构：区块标题一样、字段标签一样，只有位置不同

check('「掌握程度」在语言区块归语言、在 IT 技能区块归技能', () => {
  const lang = mk({ labelText: '掌握程度', kind: 'select' }, { key: 'language' });
  const tech = mk({ labelText: '掌握程度', kind: 'select' }, { key: 'itSkill' });
  assertEq(topKeyName(lang), 'languages.level');
  assertEq(topKeyName(tech), 'itSkills.level');
});

check('「获得时间」在证书区块归证书、在大赛区块归大赛', () => {
  const cert = mk({ labelText: '获得时间' }, { key: 'certificate' });
  const comp = mk({ labelText: '获得时间' }, { key: 'competition' });
  assertEq(topKeyName(cert), 'certificates.date');
  assertEq(topKeyName(comp), 'competitions.date');
});

check('「开始时间/结束时间」在四个经历区块里各归各位', () => {
  const cases = [
    ['work', 'works.startDate', 'works.endDate'],
    ['project', 'projects.startDate', 'projects.endDate'],
    ['internship', 'internships.startDate', 'internships.endDate'],
    ['studentCadre', 'studentCadreExperiences.startDate', 'studentCadreExperiences.endDate'],
  ];
  for (const [sec, expectStart, expectEnd] of cases) {
    assertEq(topKeyName(mk({ labelText: '开始时间' }, { key: sec })), expectStart, `${sec} 开始`);
    assertEq(topKeyName(mk({ labelText: '结束时间' }, { key: sec })), expectEnd, `${sec} 结束`);
  }
});

check('「工作描述」在工作经历和学生干部里分别归位', () => {
  const work = mk({ labelText: '工作描述', kind: 'textarea' }, { key: 'work' });
  const cadre = mk({ labelText: '工作描述', kind: 'textarea' }, { key: 'studentCadre' });
  assertEq(topKeyName(work), 'works.description');
  assertEq(topKeyName(cadre), 'studentCadreExperiences.description');
});

check('「实践经历」在竞赛区块归竞赛描述', () => {
  const d = mk({ labelText: '实践经历', kind: 'textarea' }, { key: 'competition' });
  assertEq(topKeyName(d), 'competitions.description');
});

check('新区块的标题都能识别', () => {
  assertEq(C('实践经历'), 'competition');
  assertEq(C('学生干部经历'), 'studentCadre');
  assertEq(C('IT技能'), 'itSkill');
  assertEq(C('社团经历'), 'campus');
  assertEq(C('社会实践'), 'campus');
});

check('工作表头里的「技能特长」不会被误判成 IT 技能区块', () => {
  // 「技能特长」是 basic.skills 的字段标签，不是区块标题
  assertEq(C('技能特长'), null);
});

// ═══════════════════════ 同名标签的区块归属（补充覆盖） ═══════════════════════

console.log('\n\x1b[1m同名标签靠区块区分（补充覆盖）\x1b[0m');

/** 给定区块上下文，这个标签最终落到哪个字段 */
function labelIn(label, sectionKey, kind) {
  return topKeyName(mk({ labelText: label, kind: kind || 'text' }, { key: sectionKey }));
}

check('「获得时间」在获奖区块归 awards.date', () => {
  // 早先 awards.date 的别名里只有「获奖时间」，漏了「获得时间」——
  // 网申表单的获奖区块很可能就用这个词。这条测试就是当初抓出它的那条。
  assertEq(labelIn('获得时间', 'award'), 'awards.date');
});

check('「开始时间 / 结束时间」在教育区块也归位', () => {
  assertEq(labelIn('开始时间', 'education'), 'educations.startDate');
  assertEq(labelIn('结束时间', 'education'), 'educations.endDate');
});

check('同一区块内多条经历靠槽位区分，不互相抢占', () => {
  const a = mk({ labelText: '公司名称' }, { key: 'work', entryIndex: 0 });
  const b = mk({ labelText: '公司名称' }, { key: 'work', entryIndex: 1 });
  const c = mk({ labelText: '职位名称' }, { key: 'work', entryIndex: 1 });
  const matches = RA.score.match([a, b, c]);
  assertEq(matches.length, 3, '三条都应该匹配上');
  assertEq(matches.filter((m) => m.key === 'works.company').length, 2, '两条经历的公司名都要填');
});

// ═══════════════════════ 汇总 ═══════════════════════

console.log('\n' + '─'.repeat(52));
if (failed === 0) {
  console.log(`\x1b[32m全部通过\x1b[0m  ${passed} 项`);
} else {
  console.log(`\x1b[31m失败 ${failed} 项\x1b[0m，通过 ${passed} 项`);
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
}
process.exit(failed === 0 ? 0 : 1);
