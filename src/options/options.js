/**
 * 选项页：简历填写 / 字段编辑 / JSON。
 *
 * 这里管理的是「多份简历」：每份简历有自己的字段结构（哪些分组、每组哪些字段、
 * 显示成什么名字）和自己的一份数据。系统自带一份不能删除的「通用简历」。
 *
 * 字段的 key 始终指向内置字段，所以改名和删减都不影响自动填充——
 * 匹配靠的是 key 背后的同义词表，不是显示名。
 */
(function () {
  'use strict';

  const RA = globalThis.RA;
  const $ = (id) => document.getElementById(id);

  /** 内置模板的 id，不允许删除 */
  const BUILTIN_TEMPLATE_ID = RA.storage.DEFAULT_TEMPLATE_ID;

  /** 当前简历的数据（与字段 key 对应） */
  let draft = {};
  /** 简历集合：{ activeId, list: [{ id, name, templateId }] } */
  let resumeState = { activeId: '', list: [] };
  /** 模板集合：{ list: [template] } */
  let tplState = { list: [] };
  /** 模板标签页里当前选中的模板 */
  let tplEditId = '';

  let currentTab = 'form';

  /** 填写视图收起了哪些分组（按索引）。纯 UI 状态，不落盘。 */
  const collapsedGroups = new Set();
  /** 模板视图独立一套折叠状态，互不干扰 */
  const collapsedTpl = new Set();

  // ─────────────────────── 通用 ───────────────────────

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function deepClone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }

  function setStatus(id, text, kind) {
    const node = $(id);
    if (!node) return;
    node.textContent = text || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
    if (text && kind === 'ok') {
      clearTimeout(node._timer);
      node._timer = setTimeout(() => {
        node.textContent = '';
        node.className = 'status';
      }, 2500);
    }
  }

  function activeResume() {
    return resumeState.list.find((r) => r.id === resumeState.activeId)
      || resumeState.list[0]
      || null;
  }

  function templateById(id) {
    return tplState.list.find((t) => t.id === id) || tplState.list[0] || null;
  }

  /** 当前简历使用的模板：填写视图按它渲染 */
  function activeTemplate() {
    const r = activeResume();
    return templateById(r && r.templateId);
  }

  /** 模板标签页里正在编辑的模板 */
  function editTemplate() {
    return templateById(tplEditId);
  }

  async function persistTemplates() {
    await RA.storage.setTemplates(tplState);
  }

  /** 切换简历之后重新读数据 */
  async function loadActiveProfile() {
    const p = await RA.storage.getProfile();
    draft = p ? deepClone(p) : {};
  }

  /** educations.school → school */
  function fieldName(key) {
    return key.slice(key.indexOf('.') + 1);
  }

  /** custom.cf_123 → cf_123 */
  function customId(key) {
    return key.slice('custom.'.length);
  }

  // ─────────────────────── 填写提示 ───────────────────────

  /**
   * 每个字段的填写提示（placeholder）。
   *
   * 这里不放示例数据，而是说明「这一格该写什么、什么格式」——
   * 看到「张三」用户并不知道该填自己的名字还是英文名，
   * 看到「真实姓名，与证件保持一致」才一目了然。
   */
  const FIELD_HINTS = {
    // 基本信息
    'basic.name': '真实姓名，与证件保持一致',
    'basic.nameEn': '英文或拼音写法',
    'basic.formerName': '有曾用名再填，没有可留空',
    'basic.birthday': '格式 1998-07-15',
    'basic.age': '按周岁填，只写数字',
    'basic.phone': '11 位手机号',
    'basic.phoneAlt': '第二个联系电话，没有可留空',
    'basic.homePhone': '含区号的固定电话',
    'basic.email': '常用邮箱，注意别写错',
    'basic.emailAlt': '备用邮箱，没有可留空',
    'basic.schoolEmail': '学校邮箱，如 @stu.xxx.edu.cn',
    'basic.idCard': '18 位身份证号，可自动推算生日和性别',
    'basic.idType': '没填身份证时说明证件类型',
    'basic.city': '目前实际居住的城市',
    'basic.addressProvince': '省或直辖市',
    'basic.addressDistrict': '区或县',
    'basic.address': '街道、门牌号等详细地址',
    'basic.postalCode': '6 位邮政编码',
    'basic.hometown': '祖籍，一般填到市',
    'basic.birthPlace': '出生地，一般填到市',
    'basic.hukou': '户口本上登记的所在地',
    'basic.nationality': '如：中国',
    'basic.ethnicity': '如：汉族',
    'basic.politicalStatus': '共青团员 / 中共党员 / 群众',
    'basic.maritalStatus': '未婚 / 已婚',
    'basic.height': '单位厘米，只写数字',
    'basic.weight': '单位公斤，只写数字',
    'basic.healthStatus': '如：健康 / 良好',
    'basic.wechat': '微信号，不是昵称',
    'basic.qq': 'QQ 号',
    'basic.website': '博客或 GitHub 主页链接',
    'basic.workYears': '累计工作年限，如 3 年',
    'basic.currentSalary': '当前月薪或年薪，注明单位',
    'basic.graduateYear': '毕业年份，如 2021',
    'basic.isFreshGraduate': '是 / 否',
    'basic.hobbies': '列几项，用顿号隔开',
    'basic.selfEvaluation': '突出年限、方向和代表成果',
    'basic.skills': '列出主要技术栈或技能，用斜杠分隔',

    // 求职意向
    'jobIntention.position': '想应聘的岗位名称',
    'jobIntention.city': '期望工作的城市',
    'jobIntention.salary': '期望薪资范围，注明单位',
    'jobIntention.jobType': '全职 / 实习 / 兼职',
    'jobIntention.industry': '期望进入的行业',
    'jobIntention.companyType': '期望的公司性质',
    'jobIntention.positionLevel': '期望职级，如 P6 / 高级工程师',
    'jobIntention.jobStatus': '当前求职状态',
    'jobIntention.availableFrom': '最快能到岗的时间',

    // 教育经历
    'educations.school': '学校全称，别写简称',
    'educations.college': '所在学院 / 院系，如：计算机学院',
    'educations.schoolType': '如：985 / 211 / 双一流',
    'educations.major': '专业全称',
    'educations.majorCategory': '专业所属的大类',
    'educations.minorMajor': '有辅修再填，没有可留空',
    'educations.degree': '本科 / 硕士 / 博士',
    'educations.isFullTime': '全日制 / 非全日制',
    'educations.startDate': '格式 2017-09',
    'educations.endDate': '格式 2021-06，在读填预计毕业时间',
    'educations.gpa': '如 3.8 / 4.0 或 85 / 100',
    'educations.rank': '如 5 / 120，注明总人数',
    'educations.city': '学校所在城市',
    'educations.lab': '所属实验室，没有可留空',
    'educations.mentor': '导师 / 指导教师姓名',
    'educations.courses': '列几门主修课程，用顿号隔开',
    'educations.honors': '在校获得的荣誉',
    'educations.thesisTitle': '毕业论文题目',
    'educations.description': '在校经历、社团活动、项目等',

    // 工作经历
    'works.company': '公司全称',
    'works.position': '职位名称',
    'works.department': '所属部门',
    'works.startDate': '格式 2021-07',
    'works.endDate': '格式 2024-03，在职可留空',
    'works.city': '工作所在城市',
    'works.salary': '离职前的月薪或年薪',
    'works.description': '分条写职责和成果，建议 3-5 条',
    'works.achievements': '量化成果，如性能提升 3 倍',
    'works.leaveReason': '简短说明即可',
    'works.industry': '公司所属行业',
    'works.companyType': '如：民营 / 国企 / 外企',
    'works.companyScale': '如：1000-9999 人',
    'works.subordinates': '带团队才填，写人数',
    'works.reportingTo': '汇报对象，如技术总监',
    'works.stillEmployed': '是 / 否',
    'works.employmentType': '全职 / 实习 / 外包',

    // 项目经历
    'projects.name': '项目名称',
    'projects.role': '你在项目里的角色',
    'projects.company': '公司内部项目才填',
    'projects.startDate': '格式 2023-03',
    'projects.endDate': '格式 2023-09',
    'projects.tech': '用到的技术，用斜杠分隔',
    'projects.teamSize': '团队人数',
    'projects.link': '项目主页或代码仓库链接',
    'projects.description': '项目做了什么、你负责哪部分',
    'projects.achievements': '量化成果，如日活 3 万',

    // 实习经历
    'internships.company': '实习公司全称',
    'internships.position': '实习岗位',
    'internships.department': '所属部门',
    'internships.startDate': '格式 2020-07',
    'internships.endDate': '格式 2020-09',
    'internships.city': '实习所在城市',
    'internships.description': '分条写做了哪些事、学到什么',

    // 证书
    'certificates.name': '证书的完整名称',
    'certificates.level': '证书等级或分数',
    'certificates.number': '证书编号，没有可留空',
    'certificates.issuer': '发证机构',
    'certificates.date': '格式 2019-06',

    // 语言
    'languages.name': '语种，如英语 / 日语',
    'languages.level': '精通 / 熟练 / 一般',
    'languages.score': '考试成绩，如 CET-6 560',

    // 获奖
    'awards.name': '奖项名称',
    'awards.level': '国家级 / 省级 / 校级',
    'awards.issuer': '颁奖单位',
    'awards.date': '格式 2020-10',

    // 竞赛
    'competitions.name': '竞赛名称',
    'competitions.result': '名次或奖项',
    'competitions.date': '格式 2019-11',
    'competitions.description': '参赛内容和你的贡献',

    // 校园经历
    'campusExperiences.organization': '组织或社团名称',
    'campusExperiences.role': '担任的职务',
    'campusExperiences.startDate': '格式 2018-09',
    'campusExperiences.endDate': '格式 2019-06',
    'campusExperiences.description': '做过什么、有什么结果',

    // 培训
    'trainings.name': '培训课程名称',
    'trainings.issuer': '培训机构',
    'trainings.startDate': '格式 2022-03',
    'trainings.endDate': '格式 2022-05',
    'trainings.description': '培训内容与收获',

    // 学生干部
    'studentCadreExperiences.organization': '任职的组织或班级',
    'studentCadreExperiences.role': '担任的职务',
    'studentCadreExperiences.startDate': '格式 2018-09',
    'studentCadreExperiences.endDate': '格式 2019-06',
    'studentCadreExperiences.description': '主要工作和成果',

    // 技能
    'itSkills.name': '技能名称，如 Java',
    'itSkills.level': '精通 / 熟练 / 了解',

    // 紧急联系人
    'emergency.name': '紧急联系人姓名',
    'emergency.relation': '与你的关系，如父亲',
    'emergency.phone': '11 位手机号',
  };

  /** 没单列的字段按类型兜底：日期给格式，长文本给写法，其余标「选填」 */
  function placeholderFor(field, def) {
    const p = FIELD_HINTS[field.key];
    if (p) return p;
    const types = (def && def.types) || [];
    if (types.includes('date')) return '格式 2020-09';
    if (types.includes('textarea')) return '分条写清楚，用换行分隔';
    // 自定义分组里的字段是用户自己起的名字，给不出更具体的说明
    return '选填';
  }

  // ─────────────────────── 输入控件 ───────────────────────

  function makeControl(field, value, onChange) {
    const enums = RA.fields.ENUM_OPTIONS[field.key];
    const def = RA.fields.BY_KEY[field.key];
    const isLong = def && (def.types || []).includes('textarea');

    let input;

    if (enums) {
      input = document.createElement('select');
      input.className = 'field';
      const blank = el('option', null, '请选择');
      blank.value = '';
      input.appendChild(blank);
      for (const o of enums) {
        const op = el('option', null, o);
        op.value = o;
        input.appendChild(op);
      }
      // 当前值不在预设里就补一项，否则 select 会显示成空白，
      // 用户一保存原值就没了
      if (value && !enums.includes(value)) {
        const op = el('option', null, value);
        op.value = value;
        input.appendChild(op);
      }
      input.value = value || '';
      input.addEventListener('change', () => onChange(input.value));
    } else if (isLong) {
      input = document.createElement('textarea');
      input.className = 'field field-area';
      // 默认只占两行；内容多了自动长高，见 autoGrow
      input.rows = 2;
      input.placeholder = placeholderFor(field, def);
      input.value = value || '';
      input.addEventListener('input', () => {
        onChange(input.value);
        autoGrow(input);
      });
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'field';
      input.placeholder = placeholderFor(field, def);
      input.value = value || '';
      input.addEventListener('input', () => onChange(input.value));
    }

    return input;
  }

  function makeRow(field, value, onChange) {
    const def = RA.fields.BY_KEY[field.key];
    const isLong = def && (def.types || []).includes('textarea');

    const row = el('label', 'frow' + (isLong ? ' wide' : ''));
    row.appendChild(el('span', 'flabel', RA.fields.labelOf(field)));
    row.appendChild(makeControl(field, value, onChange));
    return row;
  }

  // ─────────────────────── 分组头（两种模式共用） ───────────────────────

  /**
   * 分组标题栏：折叠箭头 + 标题 + 字段数，编辑模式下再加「内置」标记和删除按钮。
   *
   * opt = {
   *   collapsed: 用哪套折叠状态（填写视图和模板视图各一套，互不干扰）
   *   rerender:  折叠 / 删除之后重画谁
   *   template:  编辑模式下改的是这个模板
   *   statusId:  状态提示写到哪个元素
   * }
   */
  function renderGroupHeader(group, index, editing, opt) {
    const collapsed = opt.collapsed.has(index);
    const head = el('div', 'fsec-head');

    const toggle = el('button', 'fsec-toggle', collapsed ? '▸' : '▾');
    toggle.type = 'button';
    toggle.title = collapsed ? '展开这一组' : '收起这一组';
    toggle.addEventListener('click', () => {
      if (collapsed) opt.collapsed.delete(index);
      else opt.collapsed.add(index);
      opt.rerender();
    });
    head.appendChild(toggle);

    if (editing && !group.sectionKey) {
      // 自定义分组：标题可编辑
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'field fsec-title-input';
      input.value = group.title || '';
      input.placeholder = '分组名';
      input.title = '自定义分组的名字，随便改';
      input.addEventListener('change', async () => {
        group.title = input.value.trim() || '自定义分组';
        input.value = group.title;
        await persistTemplates();
        setStatus(opt.statusId || 'tpl-status', '已更新', 'ok');
      });
      head.appendChild(input);
    } else {
      head.appendChild(el('span', 'fsec-title-static', group.title || '自定义分组'));
    }

    if (editing && group.sectionKey) {
      const badge = el('span', 'fsec-badge', '内置');
      badge.title = '内置分组和字段名是固定的，防止对不上号';
      head.appendChild(badge);
    }

    head.appendChild(el('span', 'fsec-count', `${group.fields.length} 项`));

    if (editing) {
      const del = el('button', 'btn btn-sm btn-del', '删除分组');
      del.type = 'button';
      del.addEventListener('click', async () => {
        const ok = await RA.ui.dialog.confirm({
          title: '移除分组',
          message: `从模板「${opt.template.name}」里移除「${group.title}」这一组？已填的数据不会删除。`,
          okText: '移除',
          danger: true,
        });
        if (!ok) return;
        opt.template.groups = opt.template.groups.filter((g) => g !== group);
        opt.collapsed.clear();
        await persistTemplates();
        opt.rerender();
        renderForm();
      });
      head.appendChild(del);
    }

    return head;
  }

  // ─────────────────────── 文本域自适应高度 ───────────────────────

  /** 内容少就矮，内容多就长，最多 220px 之后内部滚动 */
  function autoGrow(ta) {
    if (!ta || ta.tagName !== 'TEXTAREA') return;
    const MAX = 220;
    ta.style.height = 'auto';
    const h = Math.min(ta.scrollHeight + 2, MAX);
    ta.style.height = h + 'px';
    ta.style.overflowY = ta.scrollHeight > MAX ? 'auto' : 'hidden';
  }

  function autoGrowAll() {
    // 要等元素进了 DOM 才能量出 scrollHeight
    requestAnimationFrame(() => {
      const host = $('form-body');
      if (!host) return;
      for (const ta of host.querySelectorAll('textarea.field-area')) autoGrow(ta);
    });
  }

  // ─────────────────────── 填写模式 ───────────────────────

  function renderFillGroup(group, index) {
    const sec = el('section', 'fsec');
    sec.appendChild(renderGroupHeader(group, index, false, {
      collapsed: collapsedGroups,
      rerender: renderForm,
    }));
    if (collapsedGroups.has(index)) return sec;

    const arrName = group.sectionKey ? RA.fields.ARRAY_NAME_BY_SECTION[group.sectionKey] : null;

    if (arrName) {
      sec.appendChild(renderEntries(group, arrName));
      return sec;
    }

    const grid = el('div', 'fgrid');

    if (!group.sectionKey) {
      // 自定义分组：值单独存在 draft.custom[字段id]，不和内置字段混在一起
      if (!draft.custom || typeof draft.custom !== 'object') draft.custom = {};
      for (const field of group.fields) {
        const id = customId(field.key);
        grid.appendChild(makeRow(field, draft.custom[id], (v) => { draft.custom[id] = v; }));
      }
    } else {
      if (!draft[group.sectionKey] || typeof draft[group.sectionKey] !== 'object') {
        draft[group.sectionKey] = {};
      }
      const obj = draft[group.sectionKey];
      for (const field of group.fields) {
        const name = fieldName(field.key);
        grid.appendChild(makeRow(field, obj[name], (v) => { obj[name] = v; }));
      }
    }

    sec.appendChild(grid);
    return sec;
  }

  function renderEntries(group, arrName) {
    const wrap = el('div', 'fentries');

    if (!Array.isArray(draft[arrName])) draft[arrName] = [];
    const arr = draft[arrName];
    if (!arr.length) arr.push({});

    arr.forEach((entry, index) => {
      const card = el('div', 'fentry');

      const head = el('div', 'fentry-head');
      head.appendChild(el('span', 'fentry-title', `${group.title} ${index + 1}`));

      // 只有一条时不给删除——删完还得自动补一条，反而让人困惑
      if (arr.length > 1) {
        const del = el('button', 'btn btn-sm btn-del', '删除');
        del.type = 'button';
        del.addEventListener('click', () => {
          arr.splice(index, 1);
          renderForm();
        });
        head.appendChild(del);
      }
      card.appendChild(head);

      const grid = el('div', 'fgrid');
      for (const field of group.fields) {
        const name = fieldName(field.key);
        grid.appendChild(makeRow(field, entry[name], (v) => { entry[name] = v; }));
      }
      card.appendChild(grid);
      wrap.appendChild(card);
    });

    const add = el('button', 'btn btn-add', `+ 添加一条${group.title}`);
    add.type = 'button';
    add.addEventListener('click', () => {
      arr.push({});
      renderForm();
    });
    wrap.appendChild(add);

    return wrap;
  }

  // ─────────────────────── 编辑模板模式 ───────────────────────

  /**
   * 编辑模式下的一个分组。
   *
   * 两类分组行为不同：
   *   · 内置分组 —— 名字固定（不能让用户把「手机号码」改成别的，否则自己都对不上），
   *     只能在里面加/删内置字段
   *   · 自定义分组 —— 名字和字段名都随便起，用来装内置 137 个字段覆盖不到的东西
   */
  function renderEditGroup(group, index) {
    const sec = el('section', 'fsec');
    const isCustom = !group.sectionKey;
    const tpl = editTemplate();

    sec.appendChild(renderGroupHeader(group, index, true, {
      collapsed: collapsedTpl,
      rerender: renderTemplateBody,
      template: tpl,
    }));
    if (collapsedTpl.has(index)) return sec;

    const list = el('div', 'fedit-list');
    for (const field of group.fields) {
      list.appendChild(renderEditField(group, field, isCustom));
    }
    sec.appendChild(list);

    const afterChange = async () => {
      await persistTemplates();
      renderTemplateBody();
      renderForm();
    };

    if (isCustom) {
      const add = el('button', 'btn btn-add', '+ 添加字段');
      add.type = 'button';
      add.addEventListener('click', async () => {
        group.fields.push({
          key: 'custom.cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          label: '新字段',
        });
        await afterChange();
      });
      sec.appendChild(add);
    } else {
      const remain = (RA.fields.KEYS_BY_SECTION[group.sectionKey] || [])
        .filter((k) => !group.fields.some((f) => f.key === k));

      if (remain.length) {
        const sel = makeAddSelect('＋ 添加字段…', remain.map((k) => [
          k, RA.fields.BY_KEY[k] ? RA.fields.BY_KEY[k].label : k,
        ]));
        sel.addEventListener('change', async () => {
          if (!sel.value) return;
          group.fields.push({ key: sel.value });
          await afterChange();
        });
        sec.appendChild(sel);
        RA.ui.select.enhance(sel);
      }
    }

    return sec;
  }

  function renderEditField(group, field, isCustom) {
    const row = el('div', 'fedit-row');

    if (isCustom) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'field fedit-label';
      input.value = field.label || '';
      input.placeholder = '字段名';
      input.title = '自定义字段，名字随便起';
      input.addEventListener('change', async () => {
        field.label = input.value.trim() || '（未命名字段）';
        input.value = field.label;
        await persistTemplates();
        renderTemplateBody();
        renderForm();
        setStatus('tpl-status', '已更新', 'ok');
      });
      row.appendChild(input);
    } else {
      // 内置字段名固定，只显示不可编辑
      const label = el('span', 'fedit-static', RA.fields.labelOf(field));
      label.title = '内置字段名固定，不能修改';
      row.appendChild(label);
    }

    const del = el('button', 'btn btn-sm btn-del', '删除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      group.fields = group.fields.filter((f) => f !== field);
      await persistTemplates();
      renderTemplateBody();
      renderForm();
    });
    row.appendChild(del);

    return row;
  }

  function renderAddGroup() {
    const tpl = editTemplate();
    if (!tpl) return el('div', 'note', '还没有可用模板。');

    const remain = RA.fields.SECTION_ORDER.filter(
      (sk) => !tpl.groups.some((g) => g.sectionKey === sk)
    );

    const wrap = el('div', 'fadd-group');

    const options = remain.map((sk) => [sk, RA.fields.SECTION_LABEL[sk] || sk]);
    options.push(['__custom__', '＋ 新建自定义分组']);

    const sel = makeAddSelect('＋ 添加分组…', options);
    sel.addEventListener('change', async () => {
      if (!sel.value) return;

      if (sel.value === '__custom__') {
        const n = tpl.groups.filter((g) => !g.sectionKey).length + 1;
        tpl.groups.push({
          sectionKey: null,
          title: '自定义分组 ' + n,
          fields: [],
        });
      } else {
        const sk = sel.value;
        tpl.groups.push({
          sectionKey: sk,
          title: RA.fields.SECTION_LABEL[sk] || sk,
          fields: (RA.fields.KEYS_BY_SECTION[sk] || []).map((k) => ({ key: k })),
        });
      }

      await persistTemplates();
      renderTemplateBody();
      renderForm();
    });
    wrap.appendChild(sel);
    RA.ui.select.enhance(sel);

    return wrap;
  }

  function makeAddSelect(placeholder, options) {
    const sel = document.createElement('select');
    sel.className = 'field fadd-select';

    const blank = el('option', null, placeholder);
    blank.value = '';
    sel.appendChild(blank);

    for (const [value, label] of options) {
      const o = el('option', null, label);
      o.value = value;
      sel.appendChild(o);
    }
    sel.value = '';
    return sel;
  }

  // ─────────────────────── 渲染入口 ───────────────────────

  /** 填写视图：按当前简历所用的模板渲染 */
  function renderForm() {
    const host = $('form-body');
    if (!host) return;

    const scroll = window.scrollY;
    host.textContent = '';

    const tpl = activeTemplate();
    if (!tpl || !Array.isArray(tpl.groups) || !tpl.groups.length) {
      host.appendChild(el('div', 'note',
        '这份简历所用的模板还没有字段，去「模板」标签页加几个分组。'));
      return;
    }

    tpl.groups.forEach((group, index) => {
      if (!group.fields.length) return; // 空分组在填写视图里不显示
      host.appendChild(renderFillGroup(group, index));
    });

    autoGrowAll();
    window.scrollTo(0, scroll);
  }

  /** 模板视图：编辑 tplEditId 指向的那个模板的结构 */
  function renderTemplateBody() {
    const host = $('tpl-body');
    if (!host) return;

    const scroll = window.scrollY;
    host.textContent = '';

    const tpl = editTemplate();
    if (!tpl) {
      host.appendChild(el('div', 'note', '没有可编辑的模板。'));
      return;
    }

    if (!tpl.groups.length) {
      host.appendChild(el('div', 'note', '这个模板还没有分组，用下面的「添加分组」加一个。'));
    } else {
      tpl.groups.forEach((group, index) => {
        host.appendChild(renderEditGroup(group, index));
      });
    }

    host.appendChild(renderAddGroup());
    window.scrollTo(0, scroll);
  }

  function renderResumeSelect() {
    const sel = $('resume-select');
    sel.textContent = '';
    for (const r of resumeState.list) {
      const o = el('option', null, r.name);
      o.value = r.id;
      sel.appendChild(o);
    }
    sel.value = resumeState.activeId;

    const del = $('btn-resume-delete');
    const last = resumeState.list.length <= 1;
    del.disabled = last;
    del.title = last ? '至少要保留一份简历' : '删除这份简历（连同它的数据）';

    const tpl = activeTemplate();
    $('resume-hint').textContent = tpl
      ? `使用模板：${tpl.name}　·　填充时用的就是这份简历的数据`
      : '';
  }

  function renderTemplateSelect() {
    const sel = $('tpl-select');
    sel.textContent = '';
    for (const t of tplState.list) {
      const o = el('option', null, t.name);
      o.value = t.id;
      sel.appendChild(o);
    }
    sel.value = tplEditId;

    const del = $('btn-tpl-delete');
    const isBuiltin = tplEditId === BUILTIN_TEMPLATE_ID;
    del.disabled = isBuiltin;
    del.title = isBuiltin ? '内置模板不能删除' : '删除这个模板';

    const tpl = editTemplate();
    const uses = resumeState.list.filter((r) => r.templateId === (tpl && tpl.id));
    $('tpl-usage').textContent = !tpl
      ? ''
      : uses.length
        ? `有 ${uses.length} 份简历在用这个模板（${uses.map((r) => r.name).join('、')}），改动会同时生效。`
        : '还没有简历使用这个模板。';
  }

  /** JSON 视图跟着 draft 走 */
  function syncJsonFromDraft() {
    $('json').value = JSON.stringify(pruneEmpty(draft), null, 2);
    renderIssues([]);

    const r = activeResume();
    const tpl = activeTemplate();
    $('json-target').textContent = r
      ? `正在编辑：${r.name}${tpl ? `（模板：${tpl.name}）` : ''}`
      : '';
  }

  /** 导入区的目标下拉：所有简历 + 「新建一份」 */
  function renderImportTarget() {
    const sel = $('imp-target');
    if (!sel) return;

    sel.textContent = '';
    for (const r of resumeState.list) {
      const o = el('option', null, r.name);
      o.value = r.id;
      sel.appendChild(o);
    }

    const create = el('option', null, '＋ 新建一份简历…');
    create.value = '__new__';
    sel.appendChild(create);

    sel.value = resumeState.activeId;
  }

  /** 简历名字之类的变动之后，整套界面重画一遍 */
  function renderAll() {
    renderResumeSelect();
    renderTemplateSelect();
    renderImportTarget();
    renderForm();
    if (currentTab === 'tpl') renderTemplateBody();
  }

  // ─────────────────────── 简历增删改 ───────────────────────

  /** 新建简历的弹窗：名字 + 用哪个模板 */
  let modalResolve = null;

  function openResumeModal(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      modalResolve = resolve;

      $('modal-title').textContent = o.title || '新建简历';
      $('modal-name').value = o.name || '';
      $('modal-ok').textContent = o.okText || '创建';

      const sel = $('modal-tpl');
      sel.textContent = '';
      for (const t of tplState.list) {
        const op = el('option', null, t.name);
        op.value = t.id;
        sel.appendChild(op);
      }
      const current = activeTemplate();
      sel.value = o.templateId || (current && current.id) || tplState.list[0].id;

      $('modal').hidden = false;
      setTimeout(() => $('modal-name').focus(), 0);
    });
  }

  function closeModal(value) {
    $('modal').hidden = true;
    const r = modalResolve;
    modalResolve = null;
    if (r) r(value);
  }

  async function newResume() {
    const picked = await openResumeModal({ title: '新建简历' });
    if (!picked) return;

    const resume = await RA.storage.createResume(picked.name, picked.templateId);
    resumeState = await RA.storage.getResumes();
    await loadActiveProfile();

    renderAll();
    syncJsonFromDraft();
    setStatus('form-status', `已新建简历「${resume.name}」`, 'ok');
  }

  async function renameResume() {
    const r = activeResume();
    if (!r) return;

    const name = await RA.ui.dialog.prompt({
      title: '重命名简历',
      label: '简历名称',
      value: r.name,
      okText: '保存',
    });
    if (!name || !name.trim()) return;

    r.name = name.trim();
    await RA.storage.setResumes(resumeState);

    renderAll();
    setStatus('form-status', '已重命名', 'ok');
  }

  async function removeResume() {
    const r = activeResume();
    if (!r) return;

    if (resumeState.list.length <= 1) {
      await RA.ui.dialog.alert({ title: '无法删除', message: '至少要保留一份简历。' });
      return;
    }

    const ok = await RA.ui.dialog.confirm({
      title: '删除简历',
      message: `确定删除简历「${r.name}」吗？\n\n它的数据也会一起删除。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;

    const res = await RA.storage.deleteResume(r.id);
    if (!res.ok) {
      await RA.ui.dialog.alert({ title: '删除失败', message: '删除失败：' + res.reason });
      return;
    }

    resumeState = await RA.storage.getResumes();
    await loadActiveProfile();

    renderAll();
    syncJsonFromDraft();
    setStatus('form-status', '简历已删除', 'ok');
  }

  // ─────────────────────── 模板增删改 ───────────────────────

  async function newTemplate() {
    const name = await RA.ui.dialog.prompt({
      title: '新建模板',
      label: '模板名称',
      value: '新模板',
      okText: '创建',
    });
    if (!name || !name.trim()) return;

    const base = editTemplate();
    const copy = base ? deepClone(base) : RA.storage.buildDefaultTemplate();
    copy.id = 'tpl_' + Date.now();
    copy.name = name.trim();

    tplState.list.push(copy);
    tplEditId = copy.id;
    await persistTemplates();

    renderTemplateSelect();
    renderTemplateBody();
    setStatus('tpl-status', `已新建模板「${copy.name}」`, 'ok');
  }

  async function renameTemplate() {
    const tpl = editTemplate();
    if (!tpl) return;

    const name = await RA.ui.dialog.prompt({
      title: '重命名模板',
      label: '模板名称',
      value: tpl.name,
      okText: '保存',
    });
    if (!name || !name.trim()) return;

    tpl.name = name.trim();
    await persistTemplates();

    renderTemplateSelect();
    renderResumeSelect();
    setStatus('tpl-status', '已重命名', 'ok');
  }

  async function deleteTemplate() {
    const tpl = editTemplate();
    if (!tpl) return;

    if (tpl.id === BUILTIN_TEMPLATE_ID) {
      await RA.ui.dialog.alert({
        title: '不能删除',
        message: '内置模板不能删除。\n需要别的结构就点「新建」复制一份再改。',
      });
      return;
    }

    const uses = resumeState.list.filter((r) => r.templateId === tpl.id);
    if (uses.length) {
      await RA.ui.dialog.alert({
        title: '模板正在使用',
        message:
          `有 ${uses.length} 份简历在用这个模板：\n` +
          uses.map((r) => '· ' + r.name).join('\n') +
          '\n\n先把这些简历删掉，或者换用别的模板，再来删它。',
      });
      return;
    }

    const ok = await RA.ui.dialog.confirm({
      title: '删除模板',
      message: `确定删除模板「${tpl.name}」吗？`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;

    tplState.list = tplState.list.filter((t) => t !== tpl);
    tplEditId = tplState.list[0].id;
    await persistTemplates();

    renderTemplateSelect();
    renderTemplateBody();
    setStatus('tpl-status', '模板已删除', 'ok');
  }

  // ─────────────────────── 保存数据 ───────────────────────

  function pruneEmpty(value) {
    if (Array.isArray(value)) {
      return value
        .map(pruneEmpty)
        .filter((v) => v && typeof v === 'object' && Object.keys(v).length > 0);
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const p = pruneEmpty(v);
        if (p === '' || p == null) continue;
        if (Array.isArray(p) && !p.length) continue;
        if (typeof p === 'object' && !Array.isArray(p) && !Object.keys(p).length) continue;
        out[k] = p;
      }
      return out;
    }
    return value == null ? '' : value;
  }

  async function saveForm() {
    const clean = pruneEmpty(draft);
    const result = RA.storage.validateProfile(clean);

    if (!result.ok) {
      const msg = result.errors.filter((e) => !e.warn).map((e) => e.message).join('；');
      setStatus('form-status', '保存失败：' + msg, 'bad');
      return;
    }

    await RA.storage.setProfile(clean);
    draft = deepClone(clean);
    setStatus('form-status', '已保存', 'ok');
  }

  // ─────────────────────── JSON 视图 ───────────────────────

  function parseWithLocation(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const m = /position (\d+)/.exec(msg);
      let detail = msg;
      if (m) {
        const pos = +m[1];
        const before = text.slice(0, pos);
        const line = before.split('\n').length;
        const col = pos - before.lastIndexOf('\n');
        detail = `第 ${line} 行第 ${col} 列：${msg.replace(/\s*\(line \d+ column \d+\)/, '')}`;
      }
      return { ok: false, error: detail };
    }
  }

  function renderIssues(errors) {
    const box = $('issues');
    box.textContent = '';

    if (!errors || !errors.length) {
      box.hidden = true;
      return;
    }

    const head = el('div', 'head');
    const hard = errors.filter((e) => !e.warn).length;
    const soft = errors.length - hard;
    head.textContent = hard
      ? `发现 ${hard} 个错误${soft ? `、${soft} 条提示` : ''}`
      : `${soft} 条提示`;
    box.appendChild(head);

    const ul = document.createElement('ul');
    for (const e of errors) {
      const li = el('li', e.warn ? 'warn' : '');
      li.appendChild(el('span', 'path', e.path || ''));
      li.appendChild(el('span', 'msg', e.message || ''));
      ul.appendChild(li);
    }
    box.appendChild(ul);
    box.hidden = false;
  }

  function validateNow() {
    const text = $('json').value.trim();
    if (!text) {
      renderIssues([]);
      return null;
    }
    const parsed = parseWithLocation(text);
    if (!parsed.ok) {
      renderIssues([{ path: 'JSON 语法', message: parsed.error }]);
      return null;
    }
    const result = RA.storage.validateProfile(parsed.value);
    renderIssues(result.errors);
    return parsed.value;
  }

  async function saveJson() {
    const text = $('json').value.trim();
    if (!text) {
      setStatus('status', '内容为空，没有保存', 'bad');
      renderIssues([]);
      return;
    }

    const parsed = parseWithLocation(text);
    if (!parsed.ok) {
      setStatus('status', '保存失败：JSON 格式有误', 'bad');
      renderIssues([{ path: 'JSON 语法', message: parsed.error }]);
      return;
    }

    const result = RA.storage.validateProfile(parsed.value);
    renderIssues(result.errors);

    if (!result.ok) {
      setStatus('status', '保存失败：请先修正上面的错误', 'bad');
      return;
    }

    await RA.storage.setProfile(parsed.value);
    draft = deepClone(parsed.value);
    await saveSettings();
    setStatus('status', '已保存', 'ok');
  }

  function exportJson() {
    const text = $('json').value.trim();
    if (!text) {
      setStatus('status', '没有可导出的内容', 'bad');
      return;
    }
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      $('json').value = pretty;

      const blob = new Blob([pretty], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'resume-profile.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setStatus('status', '已导出', 'ok');
    } catch (e) {
      setStatus('status', '导出失败：JSON 格式有误', 'bad');
    }
  }

  // ─────────────────────── 从 AI 导入 ───────────────────────

  /** 识别之后、点「覆盖 / 填补」之前，结果先放这儿 */
  let pendingImport = null;

  function setImpStatus(text, kind) {
    setStatus('imp-status', text, kind);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 落到下面的回退 */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function copyPrompt() {
    let tpl = null;
    try { tpl = activeTemplate(); } catch (e) { tpl = null; }

    const text = RA.importer.buildPrompt(tpl);
    const ok = await copyText(text);
    setImpStatus(
      ok ? '提示词已复制，粘贴到 AI 里，再把结果带回来' : '复制失败，请手动选中复制',
      ok ? 'ok' : 'bad'
    );
  }

  function parseImport(text) {
    const raw = String(text || '').trim();
    if (!raw) {
      setImpStatus('先粘贴 JSON 或选择文件', 'bad');
      return;
    }

    const got = RA.importer.extractJson(raw);
    if (!got.ok) {
      pendingImport = null;
      $('import-report').hidden = true;
      setImpStatus(got.error, 'bad');
      return;
    }

    const norm = RA.importer.normalizeProfile(got.value);
    if (norm.error) {
      pendingImport = null;
      $('import-report').hidden = true;
      setImpStatus(norm.error, 'bad');
      return;
    }

    const checked = RA.storage.validateProfile(norm.profile);

    pendingImport = {
      profile: norm.profile,
      fixes: norm.fixes,
      unknown: norm.unknown,
      mapped: norm.mapped,
      errors: checked.errors,
      repaired: got.repaired,
    };

    renderImportReport(pendingImport);
    setImpStatus('识别完成，确认后再写入', 'ok');
  }

  function renderImportReport(r) {
    const box = $('import-report');
    box.textContent = '';
    box.hidden = false;

    const n = RA.importer.countValues(r.profile);
    const hard = r.errors.filter((e) => !e.warn);
    const soft = r.errors.filter((e) => e.warn);

    const stats = el('div', 'imp-stats');
    const add = (label, value) => {
      const s = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = String(value);
      s.appendChild(b);
      s.appendChild(document.createTextNode(' ' + label));
      stats.appendChild(s);
    };
    add('个字段', n);
    if (r.mapped) add('个中文键已映射', r.mapped);
    if (r.fixes.length) add('处修正', r.fixes.length);
    if (r.unknown.length) add('项未识别', r.unknown.length);
    box.appendChild(stats);

    if (hard.length) {
      const ul = document.createElement('ul');
      ul.className = 'imp-list';
      for (const e of hard.slice(0, 10)) {
        ul.appendChild(el('li', 'bad', `${e.path || ''}：${e.message || ''}`));
      }
      box.appendChild(ul);
    }

    if (r.fixes.length) {
      const ul = document.createElement('ul');
      ul.className = 'imp-list';
      for (const f of r.fixes.slice(0, 10)) ul.appendChild(el('li', '', f));
      if (r.fixes.length > 10) {
        ul.appendChild(el('li', '', `…另有 ${r.fixes.length - 10} 处`));
      }
      box.appendChild(ul);
    }

    if (r.unknown.length) {
      const names = r.unknown.slice(0, 12).join('、');
      box.appendChild(el('p', 'note',
        `这些键不认识，已忽略：${names}${r.unknown.length > 12 ? ' 等' : ''}`));
    }

    if (soft.length) {
      box.appendChild(el('p', 'note', soft.slice(0, 5).map((e) => e.message).join('；')));
    }

    if (!n) {
      box.appendChild(el('p', 'note',
        '没识别出任何字段——检查一下 AI 输出的 key 是否和提示词里的对得上。'));
    }

    const row = el('div', 'imp-apply');

    const over = el('button', 'btn btn-primary', '覆盖现有数据');
    over.disabled = hard.length > 0 || n === 0;
    over.addEventListener('click', () => applyImport('overwrite'));

    const fill = el('button', 'btn', '只填补空字段');
    fill.disabled = hard.length > 0 || n === 0;
    fill.addEventListener('click', () => applyImport('fill'));

    const cancel = el('button', 'btn', '取消');
    cancel.addEventListener('click', () => {
      pendingImport = null;
      box.hidden = true;
      setImpStatus('');
    });

    row.appendChild(over);
    row.appendChild(fill);
    row.appendChild(cancel);
    box.appendChild(row);
  }

  /** 只填空白：已有内容一律保留，数组整体看待 */
  function mergeFill(current, incoming) {
    const out = deepClone(current || {});

    const mergeInto = (cur, inc) => {
      for (const [k, v] of Object.entries(inc)) {
        if (Array.isArray(v)) {
          if (!Array.isArray(cur[k]) || !cur[k].length) cur[k] = deepClone(v);
          continue;
        }
        if (v && typeof v === 'object') {
          if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
          mergeInto(cur[k], v);
          continue;
        }
        if (cur[k] == null || cur[k] === '') cur[k] = v;
      }
    };

    mergeInto(out, incoming);
    return out;
  }

  async function applyImport(mode) {
    if (!pendingImport) return;

    let resumeId = $('imp-target').value;
    let createdName = '';

    // 「新建一份简历再导入」
    if (resumeId === '__new__') {
      const picked = await openResumeModal({
        title: '把导入的数据存成新简历',
        okText: '创建并导入',
      });
      if (!picked) return;

      const resume = await RA.storage.createResume(picked.name, picked.templateId);
      resumeState = await RA.storage.getResumes();
      resumeId = resume.id;
      createdName = resume.name;
    }

    const current = resumeId === resumeState.activeId
      ? draft
      : await RA.storage.getProfileFor(resumeId);

    const next = mode === 'overwrite'
      ? deepClone(pendingImport.profile)
      : mergeFill(current || {}, pendingImport.profile);

    const checked = RA.storage.validateProfile(next);
    if (!checked.ok) {
      setImpStatus('导入的数据还有格式问题，先修正再保存', 'bad');
      return;
    }

    await RA.storage.setProfileFor(resumeId, next);

    // 导入到当前简历（或刚新建的那份）时，界面要跟着刷新
    if (resumeId === resumeState.activeId) {
      draft = deepClone(next);
      syncJsonFromDraft();
      renderResumeSelect();
      renderForm();
    }

    pendingImport = null;
    $('import-report').hidden = true;
    $('import-text').value = '';

    const target = resumeState.list.find((r) => r.id === resumeId);
    const name = target ? target.name : '';

    setImpStatus(
      createdName
        ? `已新建简历「${createdName}」并导入`
        : (mode === 'overwrite' ? `已覆盖「${name}」的数据` : `已把空字段补进「${name}」`),
      'ok'
    );
  }

  async function readImportFile(file) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setImpStatus('文件太大（超过 4 MB）', 'bad');
      return;
    }
    try {
      const text = await file.text();
      $('import-text').value = text;
      parseImport(text);
    } catch (e) {
      setImpStatus('读取文件失败', 'bad');
    }
  }

  // ─────────────────────── 整包备份 ───────────────────────

  async function exportBackup() {
    try {
      const data = await RA.storage.exportAll();
      const pretty = JSON.stringify(data, null, 2);

      const blob = new Blob([pretty], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'resume-assistant-backup.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setStatus('backup-status',
        `已导出 ${data.templates.list.length} 个模板、${data.resumes.list.length} 份简历`, 'ok');
    } catch (e) {
      setStatus('backup-status', '导出失败：' + (e && e.message), 'bad');
    }
  }

  /** 恢复之后把内存里的状态全部重新读一遍 */
  async function reloadAllState() {
    resumeState = await RA.storage.getResumes();
    tplState = await RA.storage.getTemplates();

    const r = activeResume();
    tplEditId = (r && r.templateId) || (tplState.list[0] && tplState.list[0].id) || '';

    await loadActiveProfile();

    const settings = await RA.storage.getSettings();
    $('set-theme').value = settings.theme;
    $('set-low').value = settings.lowConfidence;
    $('set-maxadd').value = settings.maxAutoAdd;
    $('set-debug').checked = !!settings.debug;
    RA.storage.applyThemeToDocument(settings.theme);

    renderAll();
    syncJsonFromDraft();
  }

  async function importBackupFile(file) {
    if (!file) return;

    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      setStatus('backup-status', '文件不是合法的 JSON', 'bad');
      return;
    }

    const tCount = data && data.templates && Array.isArray(data.templates.list)
      ? data.templates.list.length : 0;
    const rCount = data && data.resumes && Array.isArray(data.resumes.list)
      ? data.resumes.list.length : 0;

    const ok = await RA.ui.dialog.confirm({
      title: '导入备份',
      message:
        '导入会覆盖当前所有模板、简历和设置。\n\n' +
        `文件里有 ${tCount} 个模板、${rCount} 份简历。确定继续吗？`,
      okText: '覆盖导入',
      danger: true,
    });
    if (!ok) return;

    const res = await RA.storage.importAll(data);
    if (!res.ok) {
      setStatus('backup-status', res.reason || '导入失败', 'bad');
      return;
    }

    await reloadAllState();
    setStatus('backup-status', `已恢复 ${res.templates} 个模板、${res.resumes} 份简历`, 'ok');
  }

  // ─────────────────────── 标签切换 ───────────────────────

  function switchTab(name) {
    if (name === currentTab) return;

    if (name === 'json') {
      syncJsonFromDraft();
      setStatus('status', '');
    } else {
      // 离开 JSON 之前先校验，避免静默丢改动
      const text = $('json').value.trim();
      if (text) {
        const parsed = parseWithLocation(text);
        if (!parsed.ok) {
          renderIssues([{ path: 'JSON 语法', message: parsed.error }]);
          setStatus('status', 'JSON 有语法错误，修好之后再切走', 'bad');
          return;
        }
        const checked = RA.storage.validateProfile(parsed.value);
        if (!checked.ok) {
          renderIssues(checked.errors);
          setStatus('status', 'JSON 有错误，修好之后再切走', 'bad');
          return;
        }
        draft = deepClone(parsed.value);
      }
      setStatus('status', '');
      if (name === 'form') renderForm();
      if (name === 'tpl') renderTemplateBody();
    }

    currentTab = name;
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('is-active', t.dataset.tab === name);
    }
    $('tab-form').hidden = name !== 'form';
    $('tab-json').hidden = name !== 'json';
    $('tab-tpl').hidden = name !== 'tpl';
  }

  // ─────────────────────── 设置 ───────────────────────

  async function saveSettings() {
    // setSettings 是整体覆盖，每一项都得带上
    await RA.storage.setSettings({
      theme: $('set-theme').value,
      lowConfidence: $('set-low').value,
      maxAutoAdd: Math.max(0, Math.min(10, parseInt($('set-maxadd').value, 10) || 0)),
      debug: $('set-debug').checked,
    });
  }

  // ─────────────────────── 初始化 ───────────────────────

  (async function init() {
    const settings = await RA.storage.getSettings();
    RA.storage.applyThemeToDocument(settings.theme);

    resumeState = await RA.storage.getResumes();
    tplState = await RA.storage.getTemplates();

    const current = activeResume();
    tplEditId = (current && current.templateId) || (tplState.list[0] && tplState.list[0].id) || '';

    const profile = await RA.storage.getProfile();
    draft = profile ? deepClone(profile) : {};

    if (profile) {
      syncJsonFromDraft();
    } else {
      $('json').value = '';
      setStatus('status', '这份简历还没有数据；填好表单后点「保存」');
    }

    $('set-theme').value = settings.theme;
    $('set-low').value = settings.lowConfidence;
    $('set-maxadd').value = settings.maxAutoAdd;
    $('set-debug').checked = !!settings.debug;

    renderResumeSelect();
    renderTemplateSelect();
    renderImportTarget();
    renderForm();
    renderTemplateBody();

    // 原生下拉换成自绘列表
    for (const id of ['resume-select', 'tpl-select', 'modal-tpl', 'imp-target', 'set-theme', 'set-low']) {
      RA.ui.select.enhance($(id));
    }

    // ── 标签 ──
    for (const t of document.querySelectorAll('.tab')) {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    }

    // ── 简历 ──
    $('resume-select').addEventListener('change', async () => {
      await RA.storage.setActiveResume($('resume-select').value);
      resumeState = await RA.storage.getResumes();

      // 换简历就是换数据；模板页的选中项也跟着这份简历走
      const r = activeResume();
      tplEditId = (r && r.templateId) || tplEditId;

      await loadActiveProfile();
      renderAll();
      syncJsonFromDraft();
      setStatus('form-status', '已切换简历', 'ok');
    });
    $('btn-resume-new').addEventListener('click', newResume);
    $('btn-resume-rename').addEventListener('click', renameResume);
    $('btn-resume-delete').addEventListener('click', removeResume);

    // ── 模板 ──
    $('tpl-select').addEventListener('change', () => {
      tplEditId = $('tpl-select').value;
      renderTemplateSelect();
      renderTemplateBody();
    });
    $('btn-tpl-new').addEventListener('click', newTemplate);
    $('btn-tpl-rename').addEventListener('click', renameTemplate);
    $('btn-tpl-delete').addEventListener('click', deleteTemplate);

    // ── 新建简历的弹窗 ──
    $('modal-ok').addEventListener('click', () => {
      closeModal({
        name: $('modal-name').value.trim(),
        templateId: $('modal-tpl').value,
      });
    });
    $('modal-cancel').addEventListener('click', () => closeModal(null));
    $('modal').addEventListener('click', (e) => {
      if (e.target === $('modal')) closeModal(null); // 点遮罩关闭
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('modal').hidden) closeModal(null);
    });

    // ── 表单 ──
    $('btn-form-save').addEventListener('click', saveForm);

    // ── JSON ──
    $('btn-template').addEventListener('click', async () => {
      const cur = $('json').value.trim();
      if (cur) {
        const ok = await RA.ui.dialog.confirm({
          title: '载入空白 JSON',
          message: '当前内容会被空白结构覆盖，确定吗？',
          okText: '覆盖',
          danger: true,
        });
        if (!ok) return;
      }
      $('json').value = JSON.stringify(RA.storage.TEMPLATE, null, 2);
      renderIssues([]);
      setStatus('status', '已载入空白结构，把里面的空值替换成你的真实信息');
    });
    $('btn-validate').addEventListener('click', () => {
      const v = validateNow();
      setStatus('status', v ? '格式没问题（尚未保存）' : '有问题需要修正', v ? 'ok' : 'bad');
    });
    $('btn-save').addEventListener('click', saveJson);
    $('btn-export').addEventListener('click', exportJson);

    // ── 从 AI 导入 ──
    $('btn-copy-prompt').addEventListener('click', copyPrompt);
    $('btn-import-parse').addEventListener('click', () => parseImport($('import-text').value));

    $('file-json').addEventListener('change', () => {
      const f = $('file-json').files && $('file-json').files[0];
      readImportFile(f);
      $('file-json').value = ''; // 允许重复选同一个文件
    });

    const impBox = $('importer');
    impBox.addEventListener('dragover', (e) => {
      e.preventDefault();
      impBox.classList.add('is-drop');
    });
    impBox.addEventListener('dragleave', () => impBox.classList.remove('is-drop'));
    impBox.addEventListener('drop', (e) => {
      e.preventDefault();
      impBox.classList.remove('is-drop');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      readImportFile(f);
    });

    // ── 备份与恢复 ──
    $('btn-backup-export').addEventListener('click', exportBackup);
    $('file-backup').addEventListener('change', () => {
      const f = $('file-backup').files && $('file-backup').files[0];
      Promise.resolve(importBackupFile(f)).finally(() => {
        $('file-backup').value = ''; // 允许重复选同一个文件
      });
    });

    $('json').addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const ta = e.target;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 2;
    });

    // ── 设置 ──
    for (const id of ['set-theme', 'set-low', 'set-maxadd', 'set-debug']) {
      $(id).addEventListener('change', async () => {
        await saveSettings();
        RA.storage.applyThemeToDocument($('set-theme').value);
        setStatus('status', '设置已保存', 'ok');
      });
    }

    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if ($('set-theme').value === 'auto') {
          RA.storage.applyThemeToDocument('auto');
        }
      });
    } catch (e) { /* 忽略 */ }
  })();
})();
