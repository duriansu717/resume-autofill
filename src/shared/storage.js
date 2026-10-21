/**
 * 数据存取 + 校验。
 *
 * 只用 chrome.storage.local，**不用 sync**：
 *   1. 身份证号/手机号/住址属于敏感信息，sync 会上传到 Google 服务器
 *   2. sync 单个条目限制 8KB，经历多了会撑爆
 *   3. sync 在国内不可靠
 * 扩展全程不联网，数据只留在本机。
 */
(function (root) {
  'use strict';

  const RA = root.RA;
  const N = RA.normalize;

  /** 老版本的单份数据，只用于升级迁移 */
  const K_PROFILE = 'ra:profile';
  /** 每份简历的数据：{ [resumeId]: profile } */
  const K_PROFILES = 'ra:profiles';
  const K_SETTINGS = 'ra:settings';
  /** 模板集合：{ list: [template] } */
  const K_TEMPLATES = 'ra:templates';
  /** 简历集合：{ activeId, list: [{ id, name, templateId }] } */
  const K_RESUMES = 'ra:resumes';

  /** 系统自带、不允许删除的模板 */
  const DEFAULT_TEMPLATE_ID = 'tpl_default';
  /** 系统自带的简历 */
  const DEFAULT_RESUME_ID = 'resume_default';

  const DEFAULT_SETTINGS = {
    /** 低置信度字段怎么处理：'mark' 照填但标黄 | 'skip' 不填 */
    lowConfidence: 'mark',
    /** 点击「添加」按钮最多自动新增几条经历 */
    maxAutoAdd: 3,
    /** 在 console 打印候选信号表和映射表 */
    debug: false,
    /** 界面主题：'auto' 跟随系统 | 'light' | 'dark' */
    theme: 'auto',
  };

  /**
   * 初始简历数据的形状，「载入空白 JSON」用的就是它。
   *
   * 字段按「国内招聘表单实际会问什么」来定，覆盖到大多数情况。
   * 用不到的直接留空即可——留空的字段在填充时会被跳过，不会写入。
   * 数组类的经历条目按页面上的第 1、2、3 条顺序对应。
   */
  const TEMPLATE = {
    basic: {
      // 身份
      name: '',
      nameEn: '',
      formerName: '',
      gender: '',
      birthday: '1998-07-15',
      age: '',
      idCard: '',
      idType: '身份证',

      // 户籍与出生
      nationality: '中国',
      ethnicity: '',
      birthPlace: '',
      hometown: '',
      hukou: '',
      politicalStatus: '群众',
      maritalStatus: '未婚',

      // 联系方式
      phone: '',
      phoneAlt: '',
      homePhone: '',
      email: '',
      emailAlt: '',
      schoolEmail: '',
      wechat: '',
      qq: '',
      website: '',

      // 居住地址（省 / 市 / 区 分开填：很多表单是三级联动下拉）
      addressProvince: '',
      city: '',
      addressDistrict: '',
      address: '',
      postalCode: '',

      // 体征
      height: '',
      weight: '',
      healthStatus: '良好',

      // 状态
      workYears: '',
      currentSalary: '',
      graduateYear: '',
      isFreshGraduate: '否',

      // 自述
      selfEvaluation: '',
      skills: '',
      hobbies: '',
    },

    jobIntention: {
      position: '',
      city: '',
      salary: '',
      jobType: '全职',
      industry: '',
      companyType: '',
      positionLevel: '',
      jobStatus: '在职',
      availableFrom: '一个月内',
    },

    educations: [{
      school: '',
      college: '',
      schoolType: '',
      major: '',
      majorCategory: '',
      minorMajor: '',
      degree: '本科',
      isFullTime: '全日制',
      startDate: '2016-09',
      endDate: '2020-06',
      gpa: '',
      rank: '',
      city: '',
      lab: '',
      mentor: '',
      courses: '',
      honors: '',
      thesisTitle: '',
      description: '',
    }],

    works: [{
      company: '',
      companyType: '',
      companyScale: '',
      industry: '',
      department: '',
      position: '',
      employmentType: '全职',
      startDate: '2020-07',
      endDate: '2023-05',
      stillEmployed: '否',
      city: '',
      salary: '',
      reportingTo: '',
      subordinates: '',
      description: '',
      achievements: '',
      leaveReason: '',
    }],

    internships: [{
      company: '',
      department: '',
      position: '',
      startDate: '',
      endDate: '',
      city: '',
      description: '',
    }],

    projects: [{
      name: '',
      company: '',
      role: '',
      startDate: '',
      endDate: '',
      tech: '',
      teamSize: '',
      link: '',
      description: '',
      achievements: '',
    }],

    campusExperiences: [{
      organization: '',
      role: '',
      startDate: '',
      endDate: '',
      description: '',
    }],

    trainings: [{
      name: '',
      issuer: '',
      startDate: '',
      endDate: '',
      description: '',
    }],

    certificates: [{
      name: '',
      level: '',
      number: '',
      issuer: '',
      date: '',
    }],

    languages: [{
      name: '英语',
      level: '',
      score: '',
    }],

    awards: [{
      name: '',
      level: '',
      issuer: '',
      date: '',
    }],

    competitions: [{
      name: '',
      result: '',
      date: '',
      description: '',
    }],

    studentCadreExperiences: [{
      organization: '',
      role: '',
      startDate: '',
      endDate: '',
      description: '',
    }],

    itSkills: [{
      name: '',
      level: '',
    }],

    emergency: {
      name: '',
      relation: '',
      phone: '',
    },
  };

  /** 顶层是对象的字段（custom 放自定义字段，键是字段 id） */
  const OBJECT_TOP = ['basic', 'jobIntention', 'emergency', 'custom'];
  /** 顶层是数组的字段（页面上按第 1、2、3 条对应） */
  const ARRAY_TOP = [
    'educations', 'works', 'internships', 'projects',
    'campusExperiences', 'trainings', 'certificates', 'languages', 'awards',
    'competitions', 'studentCadreExperiences', 'itSkills',
  ];
  const KNOWN_TOP = [...OBJECT_TOP, ...ARRAY_TOP];
  /**
   * 这些键只要出现，值就必须是能解析的日期。
   * 注意 availableFrom（到岗时间）不在这里——它实际填的经常是
   * 「一个月内」「随时到岗」这类文字，不是日期。强行要求日期会误报。
   */
  const DATE_KEYS = ['birthday', 'startDate', 'endDate', 'date'];

  function area() {
    return (root.chrome && chrome.storage && chrome.storage.local) || null;
  }

  function get(key, fallback) {
    const a = area();
    if (!a) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      a.get(key, (res) => {
        const v = res && res[key];
        resolve(v === undefined || v === null ? fallback : v);
      });
    });
  }

  function set(key, value) {
    const a = area();
    if (!a) return Promise.resolve();
    return new Promise((resolve) => a.set({ [key]: value }, resolve));
  }

  function remove(key) {
    const a = area();
    if (!a) return Promise.resolve();
    return new Promise((resolve) => a.remove(key, resolve));
  }

  /** 所有模板各自的一份数据：{ [templateId]: profile } */
  async function getAllProfiles() {
    return (await get(K_PROFILES, null)) || {};
  }

  /**
   * 校验简历数据。返回结构化的错误列表，便于在选项页里逐条定位。
   * 不做「静默修正」——宁可报错也不要让用户以为存进去了。
   */
  function validateProfile(p) {
    const errors = [];

    if (p == null || typeof p !== 'object' || Array.isArray(p)) {
      return { ok: false, errors: [{ path: '(根)', message: '必须是一个 JSON 对象' }] };
    }

    for (const k of Object.keys(p)) {
      // 下划线开头当作注释键忽略。JSON 本身不支持注释，
      // 但用户很需要在文件里写点说明，这是通行的替代做法。
      if (k.startsWith('_')) continue;
      if (!KNOWN_TOP.includes(k)) {
        errors.push({
          path: k,
          message: `未知的顶层字段，将被忽略。可用：${KNOWN_TOP.join(' / ')}`,
          warn: true,
        });
      }
    }

    for (const k of OBJECT_TOP) {
      if (p[k] !== undefined && (typeof p[k] !== 'object' || Array.isArray(p[k]) || p[k] === null)) {
        errors.push({ path: k, message: `必须是对象，例如 "${k}": { }` });
      }
    }

    for (const k of ARRAY_TOP) {
      if (p[k] === undefined) continue;
      if (!Array.isArray(p[k])) {
        errors.push({ path: k, message: `必须是数组，例如 "${k}": [ { } ]` });
        continue;
      }
      p[k].forEach((item, i) => {
        if (item == null || typeof item !== 'object' || Array.isArray(item)) {
          errors.push({ path: `${k}[${i}]`, message: '数组的每一项都必须是对象' });
        }
      });
    }

    // 逐条检查日期格式。格式写错了匹配时会静默失配，非常难排查，所以宁可提前报错。
    const checkDates = (obj, path) => {
      if (!obj || typeof obj !== 'object') return;
      for (const dk of DATE_KEYS) {
        const v = obj[dk];
        if (v === '' || v == null) continue;
        if (!N.dateParts(v)) {
          errors.push({
            path: `${path}.${dk}`,
            message: `日期格式无法识别：「${v}」。建议写成 2020-07 或 2020-07-15`,
          });
        }
      }
      const bd = obj.birthday;
      if (bd && typeof bd === 'string' && bd.length > 0) {
        const parts = N.dateParts(bd);
        if (parts && parts.y && (parts.y < 1900 || parts.y > new Date().getFullYear())) {
          errors.push({ path: `${path}.birthday`, message: `出生年份 ${parts.y} 看起来不对` });
        }
      }
    };

    for (const k of OBJECT_TOP) checkDates(p[k], k);
    for (const k of ARRAY_TOP) {
      if (Array.isArray(p[k])) p[k].forEach((item, i) => checkDates(item, `${k}[${i}]`));
    }

    // 身份证和生日对不上是最容易犯又最难发现的错误，这里主动提示
    const id = p.basic && p.basic.idCard;
    if (typeof id === 'string' && /^\d{17}[\dXx]$/.test(id)) {
      const idBirth = `${id.slice(6, 10)}-${id.slice(10, 12)}-${id.slice(12, 14)}`;
      const stated = p.basic.birthday;
      if (stated && String(stated).replace(/\//g, '-').slice(0, 10) !== idBirth) {
        errors.push({
          path: 'basic.birthday',
          message: `填的生日是 ${stated}，但身份证号里是 ${idBirth}，两者不一致`,
        });
      }
    }

    const hard = errors.filter((e) => !e.warn);
    return { ok: hard.length === 0, errors };
  }

  /**
   * 把主题设置解析成具体值。
   *
   * 'auto' 在 JS 里就解析掉，不让 CSS 去处理——CSS 的
   * `@media (prefers-color-scheme: dark)` 和「用户强制浅色」没法优雅地组合，
   * 两边都写一份暗色变量既啰嗦又容易改漏。这里统一解析成 'light' | 'dark'，
   * CSS 只需要认一个属性选择器。
   */
  function resolveTheme(setting) {
    if (setting === 'light' || setting === 'dark') return setting;
    try {
      if (typeof matchMedia === 'function') {
        return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
    } catch (e) { /* 环境不支持就算了 */ }
    return 'light';
  }

  /**
   * 把主题应用到扩展自己的页面（弹窗、选项页）。
   * **内容脚本里不要调这个**——那会把属性写到宿主网页的 <html> 上，
   * 改变别人的页面。内容脚本用 RA.overlay.applyTheme。
   */
  function applyThemeToDocument(setting) {
    const theme = resolveTheme(setting);
    if (typeof document === 'undefined' || !document.documentElement) return theme;
    document.documentElement.setAttribute('data-theme', theme);
    return theme;
  }

  // ─────────────────────── 模板与简历 ───────────────────────

  /**
   * 模板只描述结构：包含哪些区块、每个区块里有哪些字段、字段显示成什么名字。
   * 系统自带一份「通用模板」，包含全部 135 个字段，不允许删除。
   *
   * 字段的 key 始终指向内置字段，所以改显示名、删字段都不影响自动填充——
   * 匹配靠的是 key 背后的同义词表，不是显示名。
   */
  function buildDefaultTemplate() {
    const groups = RA.fields.SECTION_ORDER
      .map((sectionKey) => ({
        sectionKey,
        title: RA.fields.SECTION_LABEL[sectionKey] || sectionKey,
        // 内置字段只存 key，显示名从定义里取——名字不允许被改
        fields: (RA.fields.KEYS_BY_SECTION[sectionKey] || []).map((key) => ({ key })),
      }))
      .filter((g) => g.fields.length);

    return { id: DEFAULT_TEMPLATE_ID, name: '通用模板', groups };
  }

  /**
   * 内置模板必须始终覆盖全部内置字段。
   * 版本升级新增字段（例如学院、导师）时，已保存的模板不会自动多出这些格子，
   * 这里按 key 补齐，保留用户已有的字段顺序、显示名和自定义字段。
   * 只处理内置模板，用户自己建的模板不擅自改动。
   */
  function completeDefaultTemplate(tpl) {
    if (!tpl || tpl.id !== DEFAULT_TEMPLATE_ID) return tpl;

    const groups = (tpl.groups || []).map((g) => ({
      ...g,
      fields: Array.isArray(g.fields) ? g.fields.slice() : [],
    }));

    for (const sectionKey of Object.keys(RA.fields.KEYS_BY_SECTION || {})) {
      const keys = RA.fields.KEYS_BY_SECTION[sectionKey] || [];
      if (!keys.length) continue;

      let group = groups.find((g) => g.sectionKey === sectionKey);
      if (!group) {
        group = {
          sectionKey,
          title: RA.fields.SECTION_LABEL[sectionKey] || sectionKey,
          fields: [],
        };
        groups.push(group);
      }

      const have = new Set(group.fields.map((f) => f && f.key));
      for (const key of keys) {
        if (!have.has(key)) group.fields.push({ key });
      }
    }

    return { ...tpl, groups };
  }

  function defaultResume() {
    return { id: DEFAULT_RESUME_ID, name: '通用简历', templateId: DEFAULT_TEMPLATE_ID };
  }

  // 迁移只跑一次；多个入口并发调用时共用同一个 Promise
  let migrating = null;

  function ensureMigrated() {
    if (!migrating) migrating = migrate();
    return migrating;
  }

  /**
   * 升级迁移。历史上有两种旧结构，这里一并处理：
   *
   *   A. 更早的版本：一份 entry 既是模板又是简历
   *      ra:templates = { activeId, list: [{ id, name, groups }] }
   *   B. 上一版：模板和数据分开了，但数据仍以模板 id 为键
   *      ra:templates = { list: [...] }，ra:profiles = { [模板 id]: 数据 }
   *
   * 两种都归并成：
   *   ra:templates → { list: [模板] }
   *   ra:resumes   → { activeId, list: [{ id, name, templateId }] }
   *   ra:profiles  → { [简历 id]: 数据 }
   *
   * 每份模板变成一个「同名简历」，数据跟着走，用户升级后看到的东西不变。
   */
  async function migrate() {
    const resumes = await get(K_RESUMES, null);
    if (resumes && Array.isArray(resumes.list) && resumes.list.length) return;

    const stored = await get(K_TEMPLATES, null);
    if (!stored || !Array.isArray(stored.list) || !stored.list.length) return;

    const oldProfiles = (await get(K_PROFILES, null)) || {};
    const legacy = await get(K_PROFILE, null);

    const nextTemplates = [];
    const nextResumes = [];
    const nextProfiles = {};

    for (const e of stored.list) {
      if (!e || !e.id) continue;

      nextTemplates.push({
        id: e.id,
        name: e.name || '模板',
        groups: Array.isArray(e.groups) ? e.groups : [],
      });

      const resId = 'res_' + e.id;
      nextResumes.push({ id: resId, name: e.name || '简历', templateId: e.id });

      if (oldProfiles[e.id] !== undefined) nextProfiles[resId] = oldProfiles[e.id];
      else if (legacy) nextProfiles[resId] = legacy;
    }

    if (!nextResumes.length) return;

    // A 类结构里 activeId 是模板 id，对应到迁移后的简历 id
    const wanted = typeof stored.activeId === 'string' ? 'res_' + stored.activeId : '';
    await set(K_TEMPLATES, { list: nextTemplates });
    await set(K_RESUMES, {
      activeId: nextResumes.some((r) => r.id === wanted) ? wanted : nextResumes[0].id,
      list: nextResumes,
    });
    await set(K_PROFILES, nextProfiles);
    await remove(K_PROFILE);
  }

  /** 模板集合。内置模板永远在列表里。 */
  async function getTemplates() {
    await ensureMigrated();
    const stored = await get(K_TEMPLATES, null);
    const list = (stored && Array.isArray(stored.list) ? stored.list : [])
      .filter((t) => t && t.id && Array.isArray(t.groups))
      // 老版本保存的内置模板缺新字段时，读取时补齐
      .map((t) => completeDefaultTemplate(t));

    if (!list.some((t) => t.id === DEFAULT_TEMPLATE_ID)) {
      list.unshift(buildDefaultTemplate());
    }
    return { list };
  }

  async function setTemplates(state) {
    return set(K_TEMPLATES, { list: (state && state.list) || [] });
  }

  /** 简历集合。至少保留一份。 */
  async function getResumes() {
    await ensureMigrated();
    const stored = await get(K_RESUMES, null);

    if (stored && Array.isArray(stored.list) && stored.list.length) {
      // activeId 可能指向一份已经被删掉的简历
      if (!stored.list.some((r) => r.id === stored.activeId)) {
        stored.activeId = stored.list[0].id;
      }
      return stored;
    }

    return { activeId: DEFAULT_RESUME_ID, list: [defaultResume()] };
  }

  async function setResumes(state) {
    return set(K_RESUMES, state);
  }

  async function setActiveResume(id) {
    const state = await getResumes();
    if (!state.list.some((r) => r.id === id)) return state;
    state.activeId = id;
    await set(K_RESUMES, state);
    return state;
  }

  /**
   * 新建一份简历：必须绑定一个模板，数据从空白开始。
   * 新简历自动成为当前简历。
   */
  async function createResume(name, templateId) {
    const state = await getResumes();
    const tpls = await getTemplates();
    const tpl = tpls.list.find((t) => t.id === templateId) || tpls.list[0];

    const id = 'res_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const resume = {
      id,
      name: String(name || '').trim() || '未命名简历',
      templateId: tpl.id,
    };

    state.list.push(resume);
    state.activeId = id;
    await set(K_RESUMES, state);
    return resume;
  }

  /** 删除一份简历连同它的数据。最后一份不让删。 */
  async function deleteResume(id) {
    const state = await getResumes();
    if (state.list.length <= 1) return { ok: false, reason: 'last' };
    if (!state.list.some((r) => r.id === id)) return { ok: false, reason: 'missing' };

    state.list = state.list.filter((r) => r.id !== id);
    if (state.activeId === id) state.activeId = state.list[0].id;
    await set(K_RESUMES, state);

    const all = await getAllProfiles();
    delete all[id];
    await set(K_PROFILES, all);

    return { ok: true, activeId: state.activeId };
  }

  /** 哪些简历在用这个模板 */
  async function resumesUsingTemplate(templateId) {
    const state = await getResumes();
    return state.list.filter((r) => r.templateId === templateId);
  }

  /** 当前简历使用的模板（数据面板、填充、导入提示词都用它） */
  async function getActiveTemplate() {
    const resumes = await getResumes();
    const resume = resumes.list.find((r) => r.id === resumes.activeId) || resumes.list[0];
    const tpls = await getTemplates();
    return tpls.list.find((t) => t.id === (resume && resume.templateId)) || tpls.list[0];
  }

  // ─────────────────────── 整包备份 ───────────────────────

  const BACKUP_TYPE = 'resume-assistant-backup';
  const BACKUP_VERSION = 1;

  /** 把模板、简历、数据和设置打包，换电脑时一个文件带走 */
  async function exportAll() {
    const templates = await getTemplates();
    const resumes = await getResumes();
    const profiles = await getAllProfiles();
    const settings = { ...DEFAULT_SETTINGS, ...(await get(K_SETTINGS, {})) };

    return {
      _type: BACKUP_TYPE,
      _version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      templates,
      resumes,
      profiles,
      settings,
    };
  }

  /**
   * 导入整包备份。会整体覆盖当前数据——调用方必须先让用户确认。
   * 这里只做结构校验和修补，不做合并：备份就是「恢复成导出时的样子」。
   */
  async function importAll(data) {
    if (!data || typeof data !== 'object' || data._type !== BACKUP_TYPE) {
      return { ok: false, reason: '这不是本扩展导出的备份文件' };
    }

    const tpls = data.templates && Array.isArray(data.templates.list) ? data.templates.list : null;
    const res = data.resumes && Array.isArray(data.resumes.list) ? data.resumes.list : null;

    if (!tpls || !tpls.length) return { ok: false, reason: '备份里没有模板' };
    if (!res || !res.length) return { ok: false, reason: '备份里没有简历' };

    const templates = tpls
      .filter((t) => t && t.id && Array.isArray(t.groups))
      .map((t) => ({ id: t.id, name: t.name || '模板', groups: t.groups }));

    if (!templates.length) return { ok: false, reason: '备份里的模板格式不对' };

    if (!templates.some((t) => t.id === DEFAULT_TEMPLATE_ID)) {
      templates.unshift(buildDefaultTemplate());
    }

    const tplIds = new Set(templates.map((t) => t.id));
    const fallback = templates.find((t) => t.id === DEFAULT_TEMPLATE_ID) || templates[0];

    const resumes = res
      .filter((r) => r && r.id)
      .map((r) => ({
        id: r.id,
        name: r.name || '简历',
        templateId: tplIds.has(r.templateId) ? r.templateId : fallback.id,
      }));

    if (!resumes.length) return { ok: false, reason: '备份里的简历格式不对' };

    const profiles = (data.profiles && typeof data.profiles === 'object' && !Array.isArray(data.profiles))
      ? data.profiles
      : {};

    const wanted = data.resumes && data.resumes.activeId;
    const activeId = resumes.some((r) => r.id === wanted) ? wanted : resumes[0].id;

    await set(K_TEMPLATES, { list: templates });
    await set(K_RESUMES, { activeId, list: resumes });
    await set(K_PROFILES, profiles);

    if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) {
      await set(K_SETTINGS, { ...DEFAULT_SETTINGS, ...data.settings });
    }

    return { ok: true, templates: templates.length, resumes: resumes.length };
  }

  /** 由身份证号推导生日/性别，用户只填身份证时能自动补上 */
  function deriveFromIdCard(idCard) {
    if (typeof idCard !== 'string' || !/^\d{17}[\dXx]$/.test(idCard)) return null;
    const y = idCard.slice(6, 10);
    const m = idCard.slice(10, 12);
    const d = idCard.slice(12, 14);
    const seq = +idCard[16];
    return {
      birthday: `${y}-${m}-${d}`,
      gender: seq % 2 === 1 ? '男' : '女',
      age: new Date().getFullYear() - +y,
    };
  }

  /** 由生日算年龄——很多表单直接问「年龄」而不是出生日期 */
  function deriveAge(birthday) {
    const p = N.dateParts(birthday);
    if (!p || !p.y) return null;
    const now = new Date();
    let age = now.getFullYear() - p.y;
    if (p.m && (now.getMonth() + 1 < p.m || (now.getMonth() + 1 === p.m && p.d && now.getDate() < p.d))) {
      age -= 1;
    }
    return age >= 0 && age < 120 ? age : null;
  }

  async function writeProfile(id, p) {
    const all = await getAllProfiles();
    all[id] = p;
    return set(K_PROFILES, all);
  }

  RA.storage = {
    /** 内置模板 id：不允许删除 */
    DEFAULT_TEMPLATE_ID,
    DEFAULT_RESUME_ID,
    K_PROFILE,
    K_PROFILES,
    K_SETTINGS,
    K_TEMPLATES,
    K_RESUMES,
    TEMPLATE,
    buildDefaultTemplate,
    completeDefaultTemplate,
    getTemplates,
    setTemplates,
    getResumes,
    setResumes,
    setActiveResume,
    createResume,
    deleteResume,
    resumesUsingTemplate,
    getActiveTemplate,
    exportAll,
    importAll,
    DEFAULT_SETTINGS,
    validateProfile,
    deriveFromIdCard,
    deriveAge,
    resolveTheme,
    applyThemeToDocument,

    /** 当前简历的数据。填充、数据面板、弹窗读的都是它。 */
    async getProfile() {
      const state = await getResumes();
      const all = await getAllProfiles();
      return all[state.activeId] || null;
    },

    async getProfileFor(id) {
      const all = await getAllProfiles();
      return all[id] || null;
    },

    async setProfile(p) {
      const state = await getResumes();
      return writeProfile(state.activeId, p);
    },

    async setProfileFor(id, p) {
      return writeProfile(id, p);
    },

    async deleteProfileFor(id) {
      const all = await getAllProfiles();
      if (!(id in all)) return;
      delete all[id];
      return set(K_PROFILES, all);
    },

    async getSettings() {
      return { ...DEFAULT_SETTINGS, ...(await get(K_SETTINGS, {})) };
    },
    async setSettings(s) {
      return set(K_SETTINGS, s);
    },
    async clearProfile() {
      const state = await getResumes();
      const all = await getAllProfiles();
      delete all[state.activeId];
      return set(K_PROFILES, all);
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
